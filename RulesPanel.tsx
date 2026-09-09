/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Checkbox, Forms, Modal, openModal, PermissionsBits, PermissionStore, Text, useState } from "@webpack/common";

import { plural } from "./SafetyTab";
import { LIVE, RULES, rulesFor, setRules } from "./watchRules";

const cl = classNameFactory("vc-ss-");

function RulesPanel({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.VIEW_AUDIT_LOG, guild);
    const [keys, setKeys] = useState<string[]>(() => rulesFor(guild.id));

    async function toggle(key: string) {
        const next = keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key];
        setKeys(next);
        await setRules(guild.id, next);
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Tell me when, in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {keys.length ? `Watching for ${plural(keys.length, "thing")}.` : "Watching for nothing."}
                    </Text>
                    <Text variant="text-sm/normal">
                        The first group fires the moment it happens. The second is read out of the audit
                        log every five minutes, so it runs a few minutes behind, and nothing from before
                        you ticked a box is reported.
                    </Text>
                    {!allowed && <Text variant="text-sm/normal">You need View Audit Log here for any of it to work.</Text>}
                </div>

                <Text variant="text-md/semibold">As it happens</Text>
                {LIVE.map(rule => (
                    <div key={rule.key} className={cl("chan-row")}>
                        <Checkbox value={keys.includes(rule.key)} onChange={() => toggle(rule.key)}>
                            <Text variant="text-sm/normal">{rule.label}</Text>
                        </Checkbox>
                    </div>
                ))}

                <Text variant="text-md/semibold">From the audit log</Text>
                {RULES.map(rule => (
                    <div key={rule.key} className={cl("chan-row")}>
                        <Checkbox value={keys.includes(rule.key)} onChange={() => toggle(rule.key)}>
                            <Text variant="text-sm/normal">{rule.label}</Text>
                        </Checkbox>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

export function openRulesPanel(guild: Guild) {
    openModal(props => <RulesPanel guild={guild} modalProps={props} />);
}
