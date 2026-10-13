// Selbershelf for Pebble: start the book played most recently, pause it, skip ahead and back.
//
// The watch only sends commands and shows what the phone says is playing. The phone side is
// android/app/src/main/java/com/audiobookshelf/app/pebble/. The command and state numbers below must match
// PebbleProtocol.kt there, and the message keys must match "messageKeys" in package.json.
//
//   Up: skip back      Select: play / pause (starts the most recent book if nothing is loaded)      Down: skip ahead
//   Hold Up: volume up      Hold Down: volume down (repeats while held, the arrow turns into + or -)
//   The screen also shows the chapter and the place in the book, and updates when the phone's player changes by itself.

#include <pebble.h>

// Commands to the phone
#define CMD_HELLO 0
#define CMD_PLAY_PAUSE 1
#define CMD_SKIP_FORWARD 2
#define CMD_SKIP_BACK 3
#define CMD_VOLUME_UP 4
#define CMD_VOLUME_DOWN 5

// What the phone tells us
#define STATE_NOTHING_TO_PLAY 0
#define STATE_PAUSED 1
#define STATE_PLAYING 2
#define STATE_LOADING 3
#define STATE_ERROR 4

#define ANSWER_TIMEOUT_MS 4000
#define LONG_PRESS_MS 500          // a button held this long changes the volume instead of skipping
#define VOLUME_REPEAT_MS 400       // while it stays held, one more step this often
#define SPINNER_FRAMES 8
#define SPINNER_MS 90              // the spinner turns one step this often while a book is starting
#define START_ANSWER_MS 15000     // the server can take a few seconds to answer when a book is started
#define START_WAIT_MS 30000        // longest the spinner stays up after the phone says it is starting
#define MAX_TITLE 64
#define MAX_CHAPTER 72

static Window *s_window;
static ActionBarLayer *s_action_bar;
static TextLayer *s_status_layer;
static TextLayer *s_title_layer;
static TextLayer *s_chapter_layer;
static TextLayer *s_time_layer;
static Layer *s_progress_layer;
static GBitmap *s_icon_play;
static GBitmap *s_icon_pause;
static GBitmap *s_icon_back;
static GBitmap *s_icon_forward;
static GBitmap *s_icon_plus;
static GBitmap *s_icon_minus;
static AppTimer *s_answer_timer;
static AppTimer *s_volume_timer;
static AppTimer *s_spinner_timer;
static GBitmap *s_spinner[SPINNER_FRAMES];
static int s_spinner_frame;
static int s_state = STATE_PAUSED;
static uint8_t s_volume_command;

static uint32_t s_position;   // seconds into the book
static uint32_t s_duration;   // seconds in the book
static char s_chapter[MAX_CHAPTER];
static char s_time[32];

static char s_title[MAX_TITLE];
static char s_status[48];

// h:mm for a time in the book
static void format_hours(char *out, size_t size, uint32_t seconds) {
  snprintf(out, size, "%lu:%02lu", (unsigned long)(seconds / 3600), (unsigned long)((seconds / 60) % 60));
}

static void progress_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_round_rect(ctx, bounds, 2);
  if (s_duration > 0) {
    int fill = (int)(((uint64_t)(bounds.size.w - 4) * s_position) / s_duration);
    if (fill > bounds.size.w - 4) fill = bounds.size.w - 4;
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, GRect(2, 2, fill, bounds.size.h - 4), 0, GCornerNone);
  }
}

static void spinner_step(void *data) {
  s_spinner_timer = NULL;
  s_spinner_frame = (s_spinner_frame + 1) % SPINNER_FRAMES;
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_spinner[s_spinner_frame]);
  s_spinner_timer = app_timer_register(SPINNER_MS, spinner_step, NULL);
}

static void spinner_start(void) {
  if (s_spinner_timer) {
    return;
  }
  s_spinner_frame = 0;
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_spinner[0]);
  s_spinner_timer = app_timer_register(SPINNER_MS, spinner_step, NULL);
}

static void spinner_stop(void) {
  if (s_spinner_timer) {
    app_timer_cancel(s_spinner_timer);
    s_spinner_timer = NULL;
  }
}

static void update_ui(int state) {
  s_state = state;
  const char *status = "";
  GBitmap *select_icon = s_icon_play;

  switch (state) {
    case STATE_PLAYING:
      status = "Playing";
      select_icon = s_icon_pause;
      break;
    case STATE_PAUSED:
      status = "Paused";
      break;
    case STATE_LOADING:
      status = "Starting...";
      break;
    case STATE_ERROR:
      status = "Can't play";
      break;
    case STATE_NOTHING_TO_PLAY:
    default:
      status = "Nothing to play";
      snprintf(s_title, sizeof(s_title), "Play a book in Selbershelf on the phone first");
      break;
  }

  snprintf(s_status, sizeof(s_status), "%s", status);
  text_layer_set_text(s_status_layer, s_status);
  text_layer_set_text(s_title_layer, s_title);
  text_layer_set_text(s_chapter_layer, s_chapter);
  text_layer_set_text(s_time_layer, s_time);
  layer_mark_dirty(s_progress_layer);
  if (state == STATE_LOADING) {
    spinner_start();
  } else {
    spinner_stop();
    action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, select_icon);
  }
}

static void show_no_answer(void *data) {
  s_answer_timer = NULL;
  spinner_stop();
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_icon_play);
  snprintf(s_status, sizeof(s_status), "No answer");
  snprintf(s_title, sizeof(s_title), "Is the Pebble app connected and Selbershelf installed?");
  text_layer_set_text(s_status_layer, s_status);
  text_layer_set_text(s_title_layer, s_title);
}

// Sends a command and waits a few seconds for the phone to answer with what is playing
static void send_command_with_timeout(uint8_t command, uint32_t timeout_ms) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Sending command %d", (int)command);
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return;
  }
  dict_write_uint8(iter, MESSAGE_KEY_Command, command);
  dict_write_end(iter);
  if (app_message_outbox_send() != APP_MSG_OK) {
    return;
  }
  if (s_answer_timer) {
    app_timer_cancel(s_answer_timer);
  }
  s_answer_timer = app_timer_register(timeout_ms, show_no_answer, NULL);
}

static void send_command(uint8_t command) {
  send_command_with_timeout(command, ANSWER_TIMEOUT_MS);
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *state = dict_find(iter, MESSAGE_KEY_State);
  Tuple *title = dict_find(iter, MESSAGE_KEY_Title);
  if (!state) {
    return;
  }
  if (s_answer_timer) {
    app_timer_cancel(s_answer_timer);
    s_answer_timer = NULL;
  }
  if (title) {
    snprintf(s_title, sizeof(s_title), "%s", title->value->cstring);
  }
  Tuple *chapter = dict_find(iter, MESSAGE_KEY_Chapter);
  Tuple *number = dict_find(iter, MESSAGE_KEY_ChapterNumber);
  Tuple *count = dict_find(iter, MESSAGE_KEY_ChapterCount);
  Tuple *position = dict_find(iter, MESSAGE_KEY_Position);
  Tuple *duration = dict_find(iter, MESSAGE_KEY_Duration);
  if (position) s_position = position->value->uint32;
  if (duration) s_duration = duration->value->uint32;
  if (number && count && number->value->uint16 > 0) {
    snprintf(s_chapter, sizeof(s_chapter), "%d/%d %s", (int)number->value->uint16, (int)count->value->uint16,
             chapter ? chapter->value->cstring : "");
  } else if (chapter) {
    snprintf(s_chapter, sizeof(s_chapter), "%s", chapter->value->cstring);
  }
  if (s_duration > 0) {
    char at[12], total[12];
    format_hours(at, sizeof(at), s_position);
    format_hours(total, sizeof(total), s_duration);
    snprintf(s_time, sizeof(s_time), "%s / %s", at, total);
  } else {
    s_time[0] = '\0';
  }
  update_ui(state->value->uint8);
  if (state->value->uint8 == STATE_LOADING) {
    // The phone says it is starting: wait for it to say playing, but not forever
    s_answer_timer = app_timer_register(START_WAIT_MS, show_no_answer, NULL);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message dropped: %d", (int)reason);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Message failed to send: %d", (int)reason);
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  send_command(CMD_SKIP_BACK);
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_state == STATE_PLAYING) {
    send_command(CMD_PLAY_PAUSE);
    return;
  }
  // Starting the book can take a few seconds (the server answers first): show it at once
  snprintf(s_status, sizeof(s_status), "Starting...");
  text_layer_set_text(s_status_layer, s_status);
  spinner_start();
  s_state = STATE_LOADING;
  send_command_with_timeout(CMD_PLAY_PAUSE, START_ANSWER_MS);
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  send_command(CMD_SKIP_FORWARD);
}

// Long press: Up is volume up, Down is volume down, repeating while held
static void volume_step(void *data) {
  send_command(s_volume_command);
  s_volume_timer = app_timer_register(VOLUME_REPEAT_MS, volume_step, NULL);
}

static void volume_stop(void) {
  if (s_volume_timer) {
    app_timer_cancel(s_volume_timer);
    s_volume_timer = NULL;
  }
  // Put the skip arrows back
  if (s_action_bar) {
    action_bar_layer_set_icon(s_action_bar, BUTTON_ID_UP, s_icon_back);
    action_bar_layer_set_icon(s_action_bar, BUTTON_ID_DOWN, s_icon_forward);
  }
}

static void volume_start(uint8_t command) {
  volume_stop();
  s_volume_command = command;
  // While held, the arrow of that button shows + or -
  action_bar_layer_set_icon(s_action_bar, command == CMD_VOLUME_UP ? BUTTON_ID_UP : BUTTON_ID_DOWN,
                            command == CMD_VOLUME_UP ? s_icon_plus : s_icon_minus);
  volume_step(NULL);
}

static void up_long_down_handler(ClickRecognizerRef recognizer, void *context) {
  volume_start(CMD_VOLUME_UP);
}

static void down_long_down_handler(ClickRecognizerRef recognizer, void *context) {
  volume_start(CMD_VOLUME_DOWN);
}

static void long_up_handler(ClickRecognizerRef recognizer, void *context) {
  volume_stop();
}

static void click_config_provider(void *context) {
  window_long_click_subscribe(BUTTON_ID_UP, LONG_PRESS_MS, up_long_down_handler, long_up_handler);
  window_long_click_subscribe(BUTTON_ID_DOWN, LONG_PRESS_MS, down_long_down_handler, long_up_handler);
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  const int content_width = bounds.size.w - ACTION_BAR_WIDTH;
  const int margin = 6;

  s_icon_play = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_PLAY);
  s_icon_pause = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_PAUSE);
  s_icon_back = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_BACK);
  s_icon_forward = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_FORWARD);
  s_icon_plus = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_PLUS);
  s_spinner[0] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_0);
  s_spinner[1] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_1);
  s_spinner[2] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_2);
  s_spinner[3] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_3);
  s_spinner[4] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_4);
  s_spinner[5] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_5);
  s_spinner[6] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_6);
  s_spinner[7] = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_SPIN_7);
  s_icon_minus = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_ICON_MINUS);

  s_action_bar = action_bar_layer_create();
  action_bar_layer_add_to_window(s_action_bar, window);
  action_bar_layer_set_click_config_provider(s_action_bar, click_config_provider);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_UP, s_icon_back);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_SELECT, s_icon_play);
  action_bar_layer_set_icon(s_action_bar, BUTTON_ID_DOWN, s_icon_forward);

  const int w = content_width - margin * 2;
  const int bar_y = bounds.size.h - 22;
  const int time_y = bar_y - 20;
  const int chapter_y = time_y - 38;

  s_status_layer = text_layer_create(GRect(margin, 2, w, 30));
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_background_color(s_status_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  s_title_layer = text_layer_create(GRect(margin, 32, w, chapter_y - 32));
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_title_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_background_color(s_title_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_chapter_layer = text_layer_create(GRect(margin, chapter_y, w, 36));
  text_layer_set_font(s_chapter_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_overflow_mode(s_chapter_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_background_color(s_chapter_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_chapter_layer));

  s_time_layer = text_layer_create(GRect(margin, time_y, w, 18));
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_background_color(s_time_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_time_layer));

  s_progress_layer = layer_create(GRect(margin, bar_y, w, 10));
  layer_set_update_proc(s_progress_layer, progress_update_proc);
  layer_add_child(root, s_progress_layer);

  snprintf(s_status, sizeof(s_status), "Connecting...");
  s_title[0] = '\0';
  s_chapter[0] = '\0';
  s_time[0] = '\0';
  text_layer_set_text(s_status_layer, s_status);
  text_layer_set_text(s_title_layer, s_title);
  text_layer_set_text(s_chapter_layer, s_chapter);
  text_layer_set_text(s_time_layer, s_time);
}

static void window_unload(Window *window) {
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_chapter_layer);
  text_layer_destroy(s_time_layer);
  layer_destroy(s_progress_layer);
  action_bar_layer_destroy(s_action_bar);
  gbitmap_destroy(s_icon_play);
  gbitmap_destroy(s_icon_pause);
  gbitmap_destroy(s_icon_back);
  gbitmap_destroy(s_icon_forward);
  spinner_stop();
  for (int i = 0; i < SPINNER_FRAMES; i++) {
    gbitmap_destroy(s_spinner[i]);
  }
  gbitmap_destroy(s_icon_plus);
  gbitmap_destroy(s_icon_minus);
  s_action_bar = NULL;
}

static void init(void) {
  s_window = window_create();
  window_set_background_color(s_window, PBL_IF_COLOR_ELSE(GColorWhite, GColorWhite));
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(256, 32);

  // Ask the phone what is playing
  send_command(CMD_HELLO);
}

static void deinit(void) {
  volume_stop();
  if (s_answer_timer) {
    app_timer_cancel(s_answer_timer);
  }
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
