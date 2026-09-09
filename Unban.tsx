/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { forget } from "./cache";
import { confirmBulk } from "./confirm";
import { Departure, everyone, syncFromAuditLog } from "./departures";
import { record } from "./History";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const PAGE = 1000;
const GAP = 400;

interface Ban {
    userId: string;
    name: string;
    reason: string | null;
    at?: number;
    by?: string;
}

interface RawBan {
    user: { id: string; username: string; global_name?: string | null; };
    reason: string | null;
}

/** the ban list pages by user id rather than by offset, so each request asks for the
 *  ones after the last id it saw */
async function allBans(guildId: string): Promise<RawBan[]> {
    const out: RawBan[] = [];
    let after: string | undefined;

    for (;;) {
        const { body } = await RestAPI.get({
            url: `/guilds/${guildId}/bans`,
            query: after ? { limit: String(PAGE), after } : { limit: String(PAGE) }
        });

        const page = body as RawBan[];
        out.push(...page);

        if (page.length < PAGE) return out;
        after = page[page.length - 1].user.id;
    }
}

function Unban({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.BAN_MEMBERS, guild);

    const [bans, setBans] = useState<Ban[]>();
    const [denied, setDenied] = useState(false);
    const [reason, setReason] = useState("");
    const [name, setName] = useState("");
    const [by, setBy] = useState("");
    const [noReason, setNoReason] = useState(false);
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    async function load() {
        try {
            const raw = await allBans(guild.id);
            await syncFromAuditLog(guild.id);
            const book: Record<string, Departure> = await everyone(guild.id);

            return raw.map(entry => ({
                userId: entry.user.id,
                name: entry.user.global_name || entry.user.username,
                reason: entry.reason,
                at: book[entry.user.id]?.at,
                by: book[entry.user.id]?.by
            }));
        } catch {
            setDenied(true);
            return [];
        }
    }

    useEffect(() => {
        let alive = true;
        load().then(found => { if (alive) setBans(found); });
        return () => { alive = false; };
    }, [guild.id]);

    const matches = (ban: Ban) => {
        if (noReason && ban.reason) return false;
        if (reason.trim() && !(ban.reason ?? "").toLowerCase().includes(reason.trim().toLowerCase())) return false;
        if (name.trim() && !ban.name.toLowerCase().includes(name.trim().toLowerCase())) return false;
        if (by.trim() && !(ban.by ?? "").toLowerCase().includes(by.trim().toLowerCase())) return false;
        return true;
    };

    const shown = bans?.filter(matches) ?? [];
    const chosen = shown.filter(ban => ticked.has(ban.userId));

    const tick = (id: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    async function lift() {
        setBusy(true);
        let done = 0;

        try {
            for (const ban of chosen) {
                await RestAPI.del({ url: `/guilds/${guild.id}/bans/${ban.userId}` });
                done++;
                setProgress(`unbanned ${done} of ${chosen.length}`);
                if (done < chosen.length) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${done}: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            if (done) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Unbanned ${plural(done, "person")}`,
                    targets: []
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
            forget(`audit:${guild.id}`);
            setBans(await load());
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Bans in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied || !allowed
                            ? "You need Ban Members here."
                            : !bans
                                ? "Reading the ban list..."
                                : `${plural(bans.length, "person")} banned, ${shown.length} match.`}
                    </Text>
                    <Text variant="text-sm/normal">
                        Dates and who banned them come from the audit log, so they stop at 45 days.
                    </Text>
                </div>

                <div className={cl("cast-row")}>
                    <TextInput value={reason} placeholder="Reason contains, optional" onChange={setReason} />
                </div>
                <div className={cl("cast-row")}>
                    <TextInput value={name} placeholder="Name contains, optional" onChange={setName} />
                </div>
                <div className={cl("cast-row")}>
                    <TextInput value={by} placeholder="Banned by, optional" onChange={setBy} />
                </div>

                <FormSwitch hideBorder title="Only ones with no reason given" value={noReason} disabled={busy} onChange={setNoReason} />

                {shown.length > 0 && (
                    <>
                        <div className={cl("purge-pick")}>
                            <Text variant="text-sm/normal">{chosen.length} of {shown.length} ticked</Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy}
                                    onClick={() => setTicked(new Set(shown.map(ban => ban.userId)))}
                                >
                                    Tick all shown
                                </Button>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy || !ticked.size}
                                    onClick={() => setTicked(new Set())}
                                >
                                    Untick all
                                </Button>
                            </div>
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {shown.slice(0, 300).map(ban => (
                                <div key={ban.userId} className={cl("safety-row")}>
                                    <Checkbox
                                        value={ticked.has(ban.userId)}
                                        onChange={() => tick(ban.userId)}
                                        disabled={busy || !allowed}
                                        align="top"
                                    >
                                        <div className={cl("safety-title")}>{ban.name}</div>
                                        <div className={cl("safety-detail")}>
                                            {ban.reason || "no reason given"}
                                            {ban.at && `, on ${new Date(ban.at).toLocaleDateString()}`}
                                            {ban.by && ` by ${ban.by}`}
                                        </div>
                                    </Checkbox>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (shown.length > 300 ? "showing the first 300, narrow it with a filter" : chosen.length ? `${plural(chosen.length, "person")} ticked` : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Unban ${plural(chosen.length, "person")}?`,
                                items: chosen.map(ban => ban.name),
                                warning: "They can come straight back in with any invite that still works.",
                                verb: "Unban them",
                                onConfirm: () => void lift()
                            })}
                        >
                            Unban ticked
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openUnbanModal(guild: Guild) {
    openModal(props => <Unban guild={guild} modalProps={props} />);
}
