import { cn } from '@/lib/cn';
import dogMark from '@/assets/dog-mark.png';

/** The pixel-art Clementine Frenchie, inlined into the bundle so it paints
 *  even while the daemon is busy (vite.config.ts assetsInlineLimit). */
export function DogMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src={dogMark}
      alt="Clementine"
      width={size}
      height={size}
      className={cn('shrink-0 rounded-md object-contain', className)}
      // Explicit CSS width/height so the icon never gets stretched by a
      // flex parent (align-items: stretch) — fixes the squished dog.
      style={{ imageRendering: 'pixelated', width: size, height: size }}
    />
  );
}
