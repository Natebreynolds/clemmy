type ClassValue = string | undefined | null | false | 0;

export default function clsx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
