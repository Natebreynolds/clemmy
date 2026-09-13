export type MockScreen = 'blank' | 'gallery' | 'populated' | 'tune' | 'proposal' | 'baseline' | 'phone';

export const MOCK_SCREENS: { id: MockScreen; label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'populated', label: 'Populated' },
  { id: 'tune', label: 'Tune' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'phone', label: 'Phone' },
];

export function isHomeMockScreen(value: string | null): value is MockScreen {
  return !!value && MOCK_SCREENS.some((screen) => screen.id === value);
}
