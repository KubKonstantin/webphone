import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { BookUser, Download, Phone, Trash2, Upload } from "lucide-react";

import { CopyNumber } from "./CopyNumber";

type Contact = {
  id: string;
  name: string;
  number: string;
};

type PhoneBookFile = {
  version: 1;
  contacts: Contact[];
};

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object") return false;
  const contact = value as Partial<Contact>;
  return typeof contact.name === "string" && contact.name.trim().length > 0
    && typeof contact.number === "string" && contact.number.trim().length > 0;
}

export function PhoneBook({ storageKey, onCall }: { storageKey: string; onCall: (number: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [message, setMessage] = useState<string>();
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown;
      setContacts(Array.isArray(stored) ? stored.filter(isContact) : []);
    } catch {
      setContacts([]);
      setMessage("Не удалось прочитать локальную телефонную книгу");
    }
  }, [storageKey]);

  const save = (next: Contact[]): boolean => {
    const sorted = [...next].sort((a, b) => a.name.localeCompare(b.name, "ru"));
    try {
      localStorage.setItem(storageKey, JSON.stringify(sorted));
      setContacts(sorted);
      return true;
    } catch {
      setMessage("Не удалось сохранить телефонную книгу в браузере");
      return false;
    }
  };

  const addContact = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedNumber = number.trim();
    if (!trimmedName || !trimmedNumber) return;
    if (!save([...contacts.filter((contact) => contact.number !== trimmedNumber), {
      id: crypto.randomUUID(),
      name: trimmedName,
      number: trimmedNumber
    }])) return;
    setName("");
    setNumber("");
    setMessage(undefined);
  };

  const exportContacts = () => {
    const payload: PhoneBookFile = { version: 1, contacts };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `web-phone-contacts-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importContacts = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const imported = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === "object" ? (parsed as Partial<PhoneBookFile>).contacts : undefined);
      if (!Array.isArray(imported) || !imported.every(isContact)) throw new Error("invalid format");
      const merged = new Map(contacts.map((contact) => [contact.number, contact]));
      imported.forEach((contact) => merged.set(contact.number.trim(), {
        id: crypto.randomUUID(),
        name: contact.name.trim(),
        number: contact.number.trim()
      }));
      if (save([...merged.values()])) setMessage(`Импортировано контактов: ${imported.length}`);
    } catch {
      setMessage("Не удалось импортировать файл: проверьте формат JSON");
    }
  };

  return (
    <section className="phonebook-panel panel">
      <div className="section-heading">
        <div><span className="eyebrow">Локально в браузере</span><h2>Телефонная книга</h2></div>
        <span className="count-badge">{contacts.length}</span>
      </div>

      <form className="contact-form" onSubmit={addContact}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Имя" aria-label="Имя контакта" />
        <input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Номер или SIP URI" aria-label="Номер контакта" />
        <button disabled={!name.trim() || !number.trim()}>Добавить</button>
      </form>

      <div className="phonebook-tools">
        <button onClick={() => importRef.current?.click()}><Upload size={16} /> Импорт</button>
        <button onClick={exportContacts} disabled={contacts.length === 0}><Download size={16} /> Экспорт</button>
        <input ref={importRef} type="file" accept="application/json,.json" onChange={(event) => void importContacts(event)} hidden />
      </div>
      {message && <div className="phonebook-message">{message}</div>}

      <div className="contact-list">
        {contacts.length === 0 ? (
          <div className="empty-state"><BookUser size={32} /><p>Добавьте контакт или импортируйте телефонную книгу</p></div>
        ) : contacts.map((contact) => (
          <div className="contact-item" key={contact.id}>
            <button className="contact-call" onClick={() => onCall(contact.number)} title="Набрать номер"><Phone size={17} /></button>
            <div><strong>{contact.name}</strong><div className="number-with-copy"><span>{contact.number}</span><CopyNumber number={contact.number} /></div></div>
            <button className="contact-delete" onClick={() => save(contacts.filter((item) => item.id !== contact.id))} title="Удалить контакт"><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
