//
//  MyViewController.swift
//  Audiobookshelf
//
//  Created by advplyr on 1/12/25.
//

import UIKit
import Capacitor

class MyViewController: CAPBridgeViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        // Do any additional setup after loading the view.
    }
    
    override var canBecomeFirstResponder: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder() // shake events go to the first responder
        #if DEBUG
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { CoreDebugProbes.runWebView(self.webView) }
        #endif
    }

    /// The shake, for the core's sensor connector (Android: SensorConnector.emitShake)
    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        super.motionEnded(motion, with: event)
        if motion == .motionShake { SensorConnector.shared.shake() }
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AbsDatabase())
        bridge?.registerPluginInstance(AbsAudioPlayer())
        bridge?.registerPluginInstance(AbsDownloader())
        bridge?.registerPluginInstance(AbsFileSystem())
        bridge?.registerPluginInstance(AbsLogger())
        bridge?.registerPluginInstance(AbsTts())
        bridge?.registerPluginInstance(AbsCorePlugin())
    }
    

    /*
    // MARK: - Navigation

    // In a storyboard-based application, you will often want to do a little preparation before navigation
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        // Get the new view controller using segue.destination.
        // Pass the selected object to the new view controller.
    }
    */

}
