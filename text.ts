/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** zero width and direction marks. they render as nothing, so a name carrying them
 *  looks identical to one that does not. written as escapes because the characters
 *  themselves are invisible in the source too. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

/** the marks that stack above and below a letter. a couple is an accent, forty is zalgo. */
const COMBINING = /[\u0300-\u036F\u0483-\u0489\u20D0-\u20F0\uFE20-\uFE2F]/g;

/** letters from other alphabets that are drawn the same as a latin one. the whole point
 *  of picking them is that the eye cannot tell, so they are mapped back before comparing. */
const LOOKALIKE: Record<string, string> = {
    "а": "a", "ᴀ": "a", "å": "a", "á": "a", "à": "a", "â": "a", "ä": "a", "ɑ": "a", "@": "a",
    "ь": "b", "β": "b", "ᴃ": "b", "8": "b",
    "с": "c", "ϲ": "c", "ᴄ": "c", "ç": "c",
    "ԁ": "d", "ᴅ": "d",
    "е": "e", "є": "e", "ᴇ": "e", "é": "e", "è": "e", "ê": "e", "ë": "e", "3": "e",
    "ɡ": "g", "ց": "g", "9": "g",
    "һ": "h", "ʜ": "h",
    "і": "i", "ı": "i", "ɪ": "i", "í": "i", "ï": "i", "1": "i", "l": "i", "|": "i", "!": "i",
    "ј": "j", "ᴊ": "j",
    "κ": "k", "ᴋ": "k",
    "ʟ": "l",
    "м": "m", "ᴍ": "m",
    "п": "n", "ɴ": "n", "ñ": "n",
    "о": "o", "ο": "o", "օ": "o", "ᴏ": "o", "ó": "o", "ò": "o", "ô": "o", "ö": "o", "0": "o",
    "р": "p", "ρ": "p", "ᴘ": "p",
    "г": "r", "ʀ": "r",
    "ѕ": "s", "ꜱ": "s", "$": "s", "5": "s",
    "т": "t", "τ": "t", "ᴛ": "t", "7": "t",
    "ᴜ": "u", "ú": "u", "ü": "u", "µ": "u",
    "ν": "v", "ᴠ": "v",
    "ᴡ": "w", "ω": "w",
    "х": "x", "χ": "x",
    "у": "y", "ʏ": "y", "ý": "y",
    "ᴢ": "z", "2": "z"
};

export const invisibleCount = (name: string) => (name.match(INVISIBLE) ?? []).length;
export const combiningCount = (name: string) => (name.match(COMBINING) ?? []).length;

export const lookalikeCount = (name: string) =>
    [...name.toLowerCase()].filter(char => LOOKALIKE[char] != null && !/[a-z0-9]/.test(char)).length;

/** what the name looks like to the eye, which is what a comparison should use */
export function flatten(name: string): string {
    return [...name.normalize("NFKD").replace(INVISIBLE, "").replace(COMBINING, "").toLowerCase()]
        .map(char => LOOKALIKE[char] ?? char)
        .join("")
        .replace(/[^a-z0-9]/g, "");
}

/** a name with the tricks taken out but still readable, for offering as a replacement */
export function clean(name: string): string {
    return name
        .replace(INVISIBLE, "")
        .replace(COMBINING, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** how many single character edits turn one into the other, given up on past `cap`
 *  so a long pair costs no more than a short one */
export function distance(a: string, b: string, cap = 3): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
            best = Math.min(best, row[j]);
        }

        if (best > cap) return cap + 1;
        previous = row;
    }

    return previous[b.length];
}
