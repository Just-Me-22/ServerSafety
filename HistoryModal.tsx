/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, Modal, openModal, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { clearHistory, drifted, Entry, readHistory, undo } from "./History";
import { list } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

function History({ modalProps }: { modalProps: RenderModalProps; }) {
    const [entries, setEntries] = useState<Entry[]>();
    const [busy, setBusy] = useState<string>();

    useEffect(() => {
        let live = true;
        readHistory().then(log => { if (live) setEntries(log); });
        return () => { live = false; };
    }, []);

    async function run(entry: Entry) {
        setBusy(entry.id);
        try {
            await undo(entry);
            setEntries(await readHistory());
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Put back" });
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setBusy(undefined);
        }
    }

    function ask(entry: Entry) {
        const off = drifted(entry);
        if (!off.length) return run(entry);

        Alerts.show({
            title: "Something changed since",
            body: (
                <div>
                    <p>{list(off)} {off.length === 1 ? "is" : "are"} not how this plugin left {off.length === 1 ? "it" : "them"} any more, so someone has changed {off.length === 1 ? "it" : "them"} since.</p>
                    <p><strong>Undoing now overwrites that newer change with what was there before.</strong></p>
                </div>
            ),
            confirmText: "Undo anyway",
            confirmColor: Button.Colors.RED,
            cancelText: "Leave it",
            onConfirm: () => run(entry)
        });
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">What this plugin has changed</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!entries
                            ? "Reading..."
                            : entries.length
                                ? `The last ${entries.length} things this plugin wrote to a server.`
                                : "This plugin has not changed anything yet."}
                    </Text>
                    <Text variant="text-sm/normal">Undo puts back exactly what was there, and warns you first if anything has moved since.</Text>
                </div>

                {entries && entries.length > 0 && (
                    <>
                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {entries.map(entry => (
                                <div key={entry.id} className={cl("safety-row", { "history-undone": entry.undoneAt != null })}>
                                    <div className={cl("safety-title")}>{entry.what}</div>
                                    <div className={cl("safety-detail")}>
                                        {entry.guildName}, {new Date(entry.at).toLocaleString()}
                                        {entry.undoneAt != null && `. Undone on ${new Date(entry.undoneAt).toLocaleString()}`}
                                    </div>
                                    {entry.undoneAt == null && entry.targets.length > 0 && (
                                        <div className={cl("safety-row-actions")}>
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                look={Button.Looks.LINK}
                                                disabled={busy != null}
                                                onClick={() => ask(entry)}
                                            >
                                                {busy === entry.id ? "Putting it back..." : "Undo this"}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </ScrollerThin>

                        <div className={cl("power-apply")}>
                            <Text variant="text-sm/normal">Clearing only forgets the log. It does not undo anything.</Text>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => clearHistory().then(() => setEntries([]))}
                            >
                                Clear the log
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openHistoryModal() {
    openModal(props => <History modalProps={props} />);
}
