export type IconName =
  | 'minus'
  | 'window-expand'
  | 'home'
  | 'device'
  | 'settings'
  | 'apps'
  | 'grid'
  | 'list'
  | 'search'
  | 'power'
  | 'unplug'
  | 'shield'
  | 'chevron'
  | 'external'
  | 'package'
  | 'network'
  | 'users'
  | 'triangle'
  | 'moon'
  | 'layers'
  | 'compass'
  | 'bell'
  | 'refresh'
  | 'x';
const paths: Record<IconName, string[]> = {
  minus: ['M5 12h14'],
  'window-expand': ['M9 3H3v6', 'm3 3 6 6', 'M15 21h6v-6', 'm21 21-6-6'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.5-1L20 9', 'M4 15l2.4 3A7 7 0 0 0 17.9 17'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  triangle: ['M10.3 3.9 1.8 18.1A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  moon: ['M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z'],
  layers: ['m12 3 10 5-10 5L2 8Z', 'm2 12 10 5 10-5', 'm2 16 10 5 10-5'],
  compass: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', 'm16.2 7.8-2.8 5.6-5.6 2.8 2.8-5.6Z'],
  home: ['m3 10 9-7 9 7', 'M5 9v12h14V9', 'M9 21v-8h6v8'],
  device: ['M4 3h16v13H4z', 'M2 20h20', 'M9 16v4m6-4v4'],
  settings: [
    'm10 3-1 3-3 1-3 3 2 2-1 4 3 2 3-1 2 3 4-1 1-3 3-2-1-4-3-1-1-3z',
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  ],
  apps: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  grid: ['M3 3h8v8H3z', 'M13 3h8v8h-8z', 'M3 13h8v8H3z', 'M13 13h8v8h-8z'],
  list: ['M8 6h13M8 12h13M8 18h13', 'M3 6h.1M3 12h.1M3 18h.1'],
  search: ['M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0', 'm15 15 6 6'],
  power: ['M12 2v10', 'M6 5a9 9 0 1 0 12 0'],
  unplug: ['m3 3 18 18', 'M8 3v4m8-4v4', 'M6 7h12v5a6 6 0 0 1-6 6v4', 'M6 7v5a6 6 0 0 0 6 6'],
  shield: ['m12 2 9 4v6c0 5-5 8-9 10-4-2-9-5-9-10V6z', 'm8 12 3 3 5-6'],
  chevron: ['m8 14 4-4 4 4'],
  external: ['M14 3h7v7', 'm21 3-12 12', 'M10 3H3v18h18v-7'],
  package: ['m12 2 9 5v10l-9 5-9-5V7z', 'm3 7 9 5 9-5', 'M12 12v10', 'm7 4 10 6'],
  network: [
    'M12 3v6M4 15v-3h16v3',
    'M9 3h6v6H9z',
    'M1 16h6v5H1z',
    'M9 16h6v5H9z',
    'M17 16h6v5h-6z',
  ],
  x: ['m6 6 12 12M6 18 18 6'],
};
export default function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name].map((d, i) => (
        <path d={d} key={i} />
      ))}
    </svg>
  );
}
