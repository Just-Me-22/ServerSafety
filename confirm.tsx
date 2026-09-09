/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { Alerts, Button } from "@webpack/common";

/** Every bulk action asked for confirmation its own way: some counted, some listed a
 *  few names, some said one line. This is the one shape they all use now. */

const SHOWN = 15;

interface Ask {
    title: string;
    /** what is about to be touched, by name. always shown, never only counted. */
    items: string[];
    /** the sentence about what cannot be taken back */
    warning: string;
    verb: string;
    onConfirm: () => void;
}

export function confirmBulk({ title, items, warning, verb, onConfirm }: Ask) {
    const rest = items.length - SHOWN;

    Alerts.show({
        title,
        body: (
            <div>
                <p>{items.slice(0, SHOWN).join(", ")}{rest > 0 ? `, and ${rest} more` : ""}</p>
                <p><strong>{warning}</strong></p>
                {rest > 0 && (
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => copyToClipboard(items.join("\n"))}
                    >
                        Copy the full list first
                    </Button>
                )}
            </div>
        ),
        confirmText: verb,
        confirmColor: Button.Colors.RED,
        cancelText: "Cancel",
        onConfirm
    });
}
