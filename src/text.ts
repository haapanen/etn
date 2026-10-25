// Info strings, command tokenizing and chat parsing helpers.

/** Parses "\key\value\key\value" (Info_ValueForKey semantics: first match wins on lookup). */
export function parseInfo(info: string): Record<string, string> {
	const out: Record<string, string> = {};
	const parts = (info.startsWith('\\') ? info.slice(1) : info).split('\\');
	for (let i = 0; i + 1 < parts.length; i += 2) {
		if (!(parts[i] in out)) out[parts[i]] = parts[i + 1];
	}
	return out;
}

/** Case-insensitive lookup like Info_ValueForKey. */
export function infoValue(info: string, key: string): string {
	const wanted = key.toLowerCase();
	for (const [k, v] of Object.entries(parseInfo(info))) {
		if (k.toLowerCase() === wanted) return v;
	}
	return '';
}

export function buildInfo(values: Record<string, string | number>): string {
	let s = '';
	for (const [k, v] of Object.entries(values)) {
		const value = String(v);
		if (/[\\;"]/.test(k) || /[\\;"]/.test(value)) {
			throw new Error(`invalid character in info string key/value: ${k}=${value}`);
		}
		s += `\\${k}\\${value}`;
	}
	return s;
}

/** Cmd_TokenizeString: whitespace separated, double quotes group, // and block comments end/skip. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	const n = text.length;
	while (out.length < 1024) {
		for (;;) {
			while (i < n && text.charCodeAt(i) <= 32) i++;
			if (i >= n) return out;
			if (text[i] === '/' && text[i + 1] === '/' && (i === 0 || text[i - 1] !== ':')) return out;
			if (text[i] === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i);
				if (end < 0) return out;
				i = end + 2;
				continue;
			}
			break;
		}
		if (text[i] === '"') {
			i++;
			const end = text.indexOf('"', i);
			if (end < 0) {
				out.push(text.slice(i));
				return out;
			}
			out.push(text.slice(i, end));
			i = end + 1;
			continue;
		}
		let tok = '';
		while (i < n && text.charCodeAt(i) > 32) {
			if (text[i] === '"') break;
			if (text[i] === '/' && text[i + 1] === '/' && (i === 0 || text[i - 1] !== ':')) break;
			if (text[i] === '/' && text[i + 1] === '*') break;
			tok += text[i++];
		}
		out.push(tok);
	}
	return out;
}

/** Removes ^x colour escapes. */
export function stripColors(s: string): string {
	return s.replace(/\^[^^]/g, '');
}

export type ChatType = 'public' | 'team' | 'fireteam';

export interface ChatMessage {
	type: ChatType;
	/** True for team and fireteam chat. */
	team: boolean;
	/** Sender name as sent by the server (may contain colour codes). */
	sender: string;
	/** Sender's map location; only present in team and fireteam chat. */
	location: string;
	clientNum: number;
	/** Message text with the colour prefix removed (colour codes inside kept). */
	message: string;
	raw: string;
}

/**
 * Parses the argument of a `chat` / `tchat` server command.
 * Server format: `chat "<name>^7: ^<c><text>" <clientNum> <localize>`; team chat is
 * `tchat "(<name>^7) (<location>): ^<c><text>"`. Team and fireteam chat share `tchat` and are
 * told apart by the message colour (cyan `5` = team, yellow `3` = fireteam).
 */
export function parseChat(name: 'chat' | 'tchat', args: string[]): ChatMessage | null {
	const raw = args[0];
	if (raw === undefined) return null;
	const clientNum = Number.parseInt(args[1] ?? '-1', 10);
	const fallback: ChatType = name === 'tchat' ? 'team' : 'public';
	const t = /^(?:\[lof\])?\((.*?)\^7\)(?: \((.*?)\))?: \^(.)([\s\S]*)$/.exec(raw);
	if (t) {
		const type: ChatType = name === 'tchat' && t[3] === '3' ? 'fireteam' : 'team';
		return { type, team: true, sender: t[1], location: t[2] ?? '', clientNum, message: t[4], raw };
	}
	const p = /^([\s\S]*?)\^7: \^(.)([\s\S]*)$/.exec(raw);
	if (p) return { type: fallback, team: fallback !== 'public', sender: p[1], location: '', clientNum, message: p[3], raw };
	return { type: fallback, team: fallback !== 'public', sender: '', location: '', clientNum, message: raw, raw };
}
