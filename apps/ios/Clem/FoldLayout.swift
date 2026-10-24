import SwiftUI

/// Where a fold crosses the app window, in the window's points (the web view
/// is full-bleed, so these are also the page's CSS pixels). A vertical fold
/// splits the window into left and right pages.
struct FoldDivision: Equatable {
    enum Axis: String { case vertical, horizontal }

    var axis: Axis
    var start: CGFloat
    var end: CGFloat

    /// Publishes the fold on the page root so the web layout can keep text
    /// and controls off the crease. `nil` clears it on a single flat display.
    static func script(_ division: FoldDivision?) -> String {
        guard let division else {
            return "(function(r){delete r.dataset.foldAxis;r.style.removeProperty('--fold-start');r.style.removeProperty('--fold-end');})(document.documentElement)"
        }
        let start = Int(division.start.rounded(.down))
        let end = Int(division.end.rounded(.up))
        return "(function(r){r.dataset.foldAxis='\(division.axis.rawValue)';r.style.setProperty('--fold-start','\(start)px');r.style.setProperty('--fold-end','\(end)px');})(document.documentElement)"
    }
}

extension View {
    /// Reports the active fold under this view, in its own coordinate space,
    /// whenever the device opens, closes, turns or resizes the window.
    func onFoldDivisionChange(_ action: @escaping (FoldDivision?) -> Void) -> some View {
        modifier(FoldDivisionReader(action: action))
    }
}

private struct FoldDivisionReader: ViewModifier {
    let action: (FoldDivision?) -> Void

    func body(content: Content) -> some View {
        content.background {
            GeometryReader { proxy in
                Color.clear.onChange(of: Self.division(in: proxy), initial: true) { _, division in
                    action(division)
                }
            }
            .ignoresSafeArea()
        }
    }

    /// Read on every layout pass: the system moves or removes the division
    /// as the device folds, so a cached value goes stale.
    private static func division(in proxy: GeometryProxy) -> FoldDivision? {
        #if canImport(SwiftUI, _version: 8.0.85)
        if #available(iOS 27.1, *) {
            guard let region = proxy.reservedRegions(kind: .division).first(where: \.isActive) else { return nil }
            let frame = region.frame
            return frame.height >= frame.width
                ? FoldDivision(axis: .vertical, start: frame.minX, end: frame.maxX)
                : FoldDivision(axis: .horizontal, start: frame.minY, end: frame.maxY)
        }
        #endif
        return nil
    }
}
