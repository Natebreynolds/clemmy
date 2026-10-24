import ObjectiveC
import UIKit
import WebKit

extension WKWebView {
    /// Removes the bar WebKit floats above the keyboard for a web form
    /// (previous, next, done). Clem's page has one field at a time and its own
    /// send button; the bar only stacked a second capsule over the composer.
    /// The keyboard still closes on a tap outside the field or on send.
    ///
    /// WebKit offers no switch for it, so the page's content view (the
    /// responder that owns the keyboard) gets a subclass whose accessory is
    /// nil, the same approach Capacitor's keyboard plugin takes.
    func hideFormAccessoryBar() {
        guard let content = scrollView.subviews.first(where: { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }) else { return }
        let base: AnyClass = type(of: content)
        let name = "\(NSStringFromClass(base))_ClemNoFormBar"
        if NSStringFromClass(base) == name { return }
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
            let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
            for selector in [#selector(getter: UIResponder.inputAccessoryView), #selector(getter: UIResponder.inputAccessoryViewController)] {
                guard let method = class_getInstanceMethod(base, selector) else { continue }
                class_addMethod(made, selector, imp_implementationWithBlock(none), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
