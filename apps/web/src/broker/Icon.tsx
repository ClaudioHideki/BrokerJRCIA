const paths: Record<string, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  connections:
    'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  providers: 'M12 3 3 7.5 12 12l9-4.5L12 3 M3 12l9 4.5 9-4.5 M3 16.5l9 4.5 9-4.5',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5',
  messages: 'M21 4H3v14h5l4 4 4-4h5V4 M7 9h10 M7 13h7',
  costs: 'M12 2v20 M17 6H9a4 4 0 0 0 0 8h6a4 4 0 0 0 0-8 M7 18h8',
  reports: 'M4 21V3h16v18H4 M8 16v-4 M12 16V8 M16 16v-6',
  health: 'M2 12h4l3-8 6 16 3-8h4',
  brain:
    'M9 3a4 4 0 0 0-4 4 4 4 0 0 0-2 7 4 4 0 0 0 6 6V3 M15 3a4 4 0 0 1 4 4 4 4 0 0 1 2 7 4 4 0 0 1-6 6V3 M9 8H6 M15 16h4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  key: 'M14 5a5 5 0 1 0 7 7 5 5 0 0 0-7-7 M13 13 3 23 M5 21l-3-3 M8 18l-3-3',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  refresh: 'M20 7a9 9 0 1 0 1 8 M20 2v6h-6',
  plus: 'M12 4v16 M4 12h16',
  globe: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  check: 'M5 12l4 4L19 6',
  info: 'M12 16v-4 M12 8v.1 M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0',
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.info} />
    </svg>
  );
}
