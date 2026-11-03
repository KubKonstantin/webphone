export const ringtoneChoices = [
  { id: "classic", label: "Классический" },
  { id: "double", label: "Двойной звонок" },
  { id: "melody", label: "Мелодичный" }
] as const;
export type RingtoneTone = typeof ringtoneChoices[number]["id"];
export function isRingtoneTone(value: unknown): value is RingtoneTone {
  return ringtoneChoices.some((choice) => choice.id === value);
}

type Note = { frequencies: number[]; offset: number; duration: number };
export const ringtoneNotes: Record<RingtoneTone, Note[]> = {
  classic: [{ frequencies: [440, 480], offset: 0, duration: 1 }],
  double: [
    { frequencies: [520, 660], offset: 0, duration: 0.28 },
    { frequencies: [520, 660], offset: 0.45, duration: 0.28 }
  ],
  melody: [
    { frequencies: [523.25], offset: 0, duration: 0.22 },
    { frequencies: [659.25], offset: 0.25, duration: 0.22 },
    { frequencies: [783.99], offset: 0.5, duration: 0.38 }
  ]
};
export const callEndedNotes: Note[] = [
  { frequencies: [480], offset: 0, duration: 0.18 },
  { frequencies: [350], offset: 0.23, duration: 0.26 }
];
