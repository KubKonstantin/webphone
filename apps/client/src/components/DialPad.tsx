const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function DialPad({ onPress, disabled }: { onPress: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="dial-pad" aria-label="Клавиатура набора">
      {keys.map((key) => (
        <button key={key} className="dial-key" disabled={disabled} onClick={() => onPress(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}
