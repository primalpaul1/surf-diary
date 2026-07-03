import Foundation
import Capacitor
import Security

@objc(KeychainPlugin)
class KeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "KeychainPlugin"
    let jsName = "Keychain"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.swellnotes.app"

    @objc func save(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("Missing key or value")
            return
        }
        // Wisp-style device-only storage: hardware-encrypted, never synced to iCloud,
        // excluded from device backups, and immune to WebView storage eviction.
        let deviceOnly = call.getBool("deviceOnly") ?? false
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrSynchronizable as String: (deviceOnly ? kCFBooleanFalse! : kCFBooleanTrue!),
            kSecAttrAccessible as String: (deviceOnly ? kSecAttrAccessibleWhenUnlockedThisDeviceOnly : kSecAttrAccessibleAfterFirstUnlock),
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve(["saved": true])
        } else {
            call.reject("Keychain save failed (status \(status))")
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess,
           let data = item as? Data,
           let str = String(data: data, encoding: .utf8) {
            call.resolve(["value": str])
        } else if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else {
            call.reject("Keychain load failed (status \(status))")
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        let status = SecItemDelete(query as CFDictionary)
        call.resolve(["cleared": status == errSecSuccess || status == errSecItemNotFound])
    }

    // List all (synchronizable) items whose account starts with `prefix`.
    // Used to enumerate encrypted key backups in iCloud Keychain on a new device.
    @objc func list(_ call: CAPPluginCall) {
        let prefix = call.getString("prefix") ?? ""
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnAttributes as String: kCFBooleanTrue!,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["items": []])
            return
        }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            call.reject("Keychain list failed (status \(status))")
            return
        }
        var out: [[String: String]] = []
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String else { continue }
            if !prefix.isEmpty && !account.hasPrefix(prefix) { continue }
            var entry: [String: String] = ["account": account]
            if let data = item[kSecValueData as String] as? Data,
               let str = String(data: data, encoding: .utf8) {
                entry["value"] = str
            }
            out.append(entry)
        }
        call.resolve(["items": out])
    }
}
