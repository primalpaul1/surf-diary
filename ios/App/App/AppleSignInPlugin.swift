import Foundation
import UIKit
import Capacitor
import AuthenticationServices

// Native Sign in with Apple, exposed to JS as Capacitor plugin "SignInWithApple"
// with one method: authorize({ nonce?, state? }) -> { response: { identityToken, user, ... } }.
// App-local plugin (registered in MainViewController), so no third-party SPM dependency.
@objc(AppleSignInPlugin)
class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AppleSignInPlugin"
    let jsName = "SignInWithApple"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?
    private var authController: ASAuthorizationController?   // retained so it survives the async callback

    @objc func authorize(_ call: CAPPluginCall) {
        pendingCall = call
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            if let nonce = call.getString("nonce") { request.nonce = nonce }
            if let state = call.getString("state") { request.state = state }
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authController = controller
            controller.performRequests()
        }
    }

    private func cleanup() { pendingCall = nil; authController = nil }
}

extension AppleSignInPlugin: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController,
                                didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            pendingCall?.reject("No identity token returned")
            cleanup()
            return
        }
        var response: [String: Any] = ["identityToken": token, "user": cred.user]
        if let codeData = cred.authorizationCode, let code = String(data: codeData, encoding: .utf8) {
            response["authorizationCode"] = code
        }
        if let email = cred.email { response["email"] = email }
        if let given = cred.fullName?.givenName { response["givenName"] = given }
        if let family = cred.fullName?.familyName { response["familyName"] = family }
        pendingCall?.resolve(["response": response])
        cleanup()
    }

    func authorizationController(controller: ASAuthorizationController,
                                didCompleteWithError error: Error) {
        pendingCall?.reject("Apple sign-in failed: \(error.localizedDescription)")
        cleanup()
    }
}

extension AppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
