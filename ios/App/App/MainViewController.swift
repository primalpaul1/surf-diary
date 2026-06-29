import UIKit
import Capacitor

// Capacitor only auto-registers plugins listed in capacitor.config.json's
// packageClassList (generated from npm Capacitor plugins). Our app-local Swift
// plugins are not packages, so we register them by hand here. capacitorDidLoad()
// runs after the bridge is created; registerPluginInstance() is the supported
// hook and is NOT gated by autoRegisterPlugins.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(StoreKitPlugin())
        bridge?.registerPluginInstance(KeychainPlugin())
        bridge?.registerPluginInstance(AppleSignInPlugin())
    }
}
