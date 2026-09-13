import { useEffect, useState } from 'preact/hooks';

/**
 * How many layout-viewport pixels the software keyboard currently covers.
 * iOS Safari keeps `position: fixed` chrome behind the keyboard; the visual
 * viewport is the honest remaining strip.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(Math.round(covered));
    };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);
  return inset;
}
