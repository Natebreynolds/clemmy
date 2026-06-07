import { cn } from '@/lib/cn';

/** The pixel-art Clementine Frenchie, served by the daemon at /console/icon.png. */
export function DogMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/console/icon.png"
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
