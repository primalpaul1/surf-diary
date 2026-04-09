import Foundation
import Capacitor
import StoreKit

@objc(StoreKitPlugin)
class StoreKitPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "StoreKitPlugin"
    let jsName = "StoreKit"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    private let productId = "com.swellnotes.pro.monthly"

    @objc func getProducts(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                let result = products.map { p in
                    return [
                        "id": p.id,
                        "displayName": p.displayName,
                        "displayPrice": p.displayPrice,
                        "description": p.description,
                    ] as [String: Any]
                }
                call.resolve(["products": result])
            } catch {
                call.reject("Failed to fetch products: \(error.localizedDescription)")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    let transaction = try checkVerified(verification)
                    await transaction.finish()
                    call.resolve([
                        "success": true,
                        "transactionId": String(transaction.id),
                        "productId": transaction.productID,
                        "originalTransactionId": String(transaction.originalID),
                    ])
                case .userCancelled:
                    call.resolve(["success": false, "cancelled": true])
                case .pending:
                    call.resolve(["success": false, "pending": true])
                @unknown default:
                    call.reject("Unknown purchase result")
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
                let isPro = await checkProStatus()
                call.resolve(["isPro": isPro])
            } catch {
                call.reject("Restore failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        Task {
            let isPro = await checkProStatus()
            call.resolve(["isPro": isPro])
        }
    }

    private func checkProStatus() async -> Bool {
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result {
                if transaction.productID == productId && transaction.revocationDate == nil {
                    return true
                }
            }
        }
        return false
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }
}
