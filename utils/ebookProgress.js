/**
 * Saves the reading position of an ebook: to the device (downloaded copy) and to the server.
 * Used by the EPUB reader and by read aloud, which saves it while the reader is closed.
 *
 * @param {object} app Vue instance (for $db, $nativeHttp and the store)
 * @param {object} target
 * @param {string|null} target.localLibraryItemId
 * @param {string|null} target.serverLibraryItemId
 * @param {{ebookLocation: string, ebookProgress?: number}} payload
 */
export async function saveEbookProgress(app, { localLibraryItemId, serverLibraryItemId }, payload) {
  if (localLibraryItemId) {
    const response = await app.$db.updateLocalEbookProgress({ localLibraryItemId, ...payload })
    if (response?.localMediaProgress) {
      app.$store.commit('globals/updateLocalMediaProgress', response.localMediaProgress)
    }
  }

  if (serverLibraryItemId) {
    app.$nativeHttp.patch(`/api/me/progress/${serverLibraryItemId}`, payload).catch((error) => {
      console.error('saveEbookProgress failed:', error)
    })
  }
}
