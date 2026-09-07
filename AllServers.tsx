/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Forms, GuildStore, IconUtils, Modal, openModal, ScrollerThin, Text, useEffect, useState } from "@webpack/common";

import { openGuildSafetyModal } from "./SafetyModal";
import { plural, SafetyState, scoreGuild, stateKey } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Row {
    guild: Guild;
    critical: number;
    total: number;
}

function summary(row: Row) {
    if (!row.total) return "Nothing to flag";
    if (!row.critical) return `${plural(row.total, "thing")} worth tightening`;
    return `${row.critical} critical of ${row.total}`;
}

function AllServers({ modalProps }: { modalProps: RenderModalProps; }) {
    const [rows, setRows] = useState<Row[]>();

    useEffect(() => {
        let live = true;

        // walking every server's channels takes a beat, so let the modal paint first
        const timer = setTimeout(async () => {
            const guilds = Object.values(GuildStore.getGuilds());
            const stored = await DataStore.getMany<SafetyState>(guilds.map(guild => stateKey(guild.id)));
            if (!live) return;

            setRows(guilds
                .map((guild, i) => ({ guild, ...scoreGuild(guild, stored[i]?.accepted ?? []) }))
                .sort((a, b) =>
                    b.critical - a.critical
                    || b.total - a.total
                    || a.guild.name.localeCompare(b.guild.name)));
        }, 0);

        return () => { live = false; clearTimeout(timer); };
    }, []);

    const flagged = rows?.filter(row => row.total).length ?? 0;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Every server you are in</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!rows
                            ? "Checking every server..."
                            : flagged
                                ? `${flagged} of ${plural(rows.length, "server")} have something worth looking at.`
                                : `All ${plural(rows.length, "server")} look fine.`}
                    </Text>
                    <Text variant="text-sm/normal">Anything you accepted in a server is left out of its count.</Text>
                </div>

                {rows && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {rows.map(row => (
                            <button
                                type="button"
                                key={row.guild.id}
                                className={cl("linkish", "servers-row", { critical: row.critical > 0 })}
                                onClick={() => {
                                    modalProps.onClose();
                                    openGuildSafetyModal(row.guild);
                                }}
                            >
                                {row.guild.icon
                                    ? <img
                                        className={cl("servers-icon")}
                                        src={IconUtils.getGuildIconURL({ id: row.guild.id, icon: row.guild.icon, canAnimate: false, size: 64 })}
                                        alt=""
                                    />
                                    : <div className={cl("servers-icon", "servers-icon-empty")} aria-hidden />}

                                <div className={cl("servers-name")}>{row.guild.name}</div>
                                <div className={cl("servers-count")}>{summary(row)}</div>
                            </button>
                        ))}
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openAllServersModal() {
    openModal(props => <AllServers modalProps={props} />);
}
