/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, GuildMemberStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, SnowflakeUtils, Text, Toasts, useEffect, useState } from "@webpack/common";

import { forget, remember } from "./cache";
import { confirmBulk } from "./confirm";
import { record } from "./History";
import { list, plural } from "./SafetyTab";
import { flatten } from "./text";

const cl = classNameFactory("vc-ss-");

const GAP = 400;
const EMOJI_CREATE = 60;
const STICKER_CREATE = 90;

interface Thing {
    id: string;
    name: string;
    kind: "emoji" | "sticker";
    animated: boolean;
    by?: string;
    byId?: string;
    at: number;
    flags: string[];
}

interface AuditEntry {
    id: string;
    user_id: string | null;
    target_id: string | null;
}

/** who added each one, from the audit log. it only reaches back 45 days, so anything
 *  older simply has no name against it. */
async function makers(guildId: string) {
    const found = new Map<string, { by: string; byId: string; }>();

    for (const action of [EMOJI_CREATE, STICKER_CREATE]) {
        try {
            const body = await remember(`audit:${guildId}:${action}`, async () => (await RestAPI.get({
                url: `/guilds/${guildId}/audit-logs`,
                query: { action_type: String(action), limit: "100" }
            })).body);

            const names = new Map((body.users ?? []).map((user: any) => [user.id, user.global_name || user.username]));

            for (const entry of (body.audit_log_entries ?? []) as AuditEntry[]) {
                if (entry.target_id && entry.user_id) {
                    found.set(entry.target_id, { by: String(names.get(entry.user_id) ?? "someone"), byId: entry.user_id });
                }
            }
        } catch {
            return null;
        }
    }

    return found;
}

function gather(guild: Guild, who: Map<string, { by: string; byId: string; }> | null): Thing[] {
    const emojis: any[] = (guild as any).emojis ?? [];
    const stickers: any[] = (guild as any).stickers ?? [];

    const all: Thing[] = [
        ...emojis.map(one => ({
            id: one.id, name: one.name, kind: "emoji" as const, animated: Boolean(one.animated),
            at: SnowflakeUtils.extractTimestamp(one.id), flags: [] as string[]
        })),
        ...stickers.map(one => ({
            id: one.id, name: one.name, kind: "sticker" as const, animated: one.format_type === 2 || one.formatType === 2,
            at: SnowflakeUtils.extractTimestamp(one.id), flags: [] as string[]
        }))
    ];

    for (const thing of all) {
        const maker = who?.get(thing.id);
        if (maker) {
            thing.by = maker.by;
            thing.byId = maker.byId;
            if (!GuildMemberStore.getMember(guild.id, maker.byId)) thing.flags.push("whoever added it has left");
        }
    }

    // two things whose names read the same are a nuisance to pick between in the picker
    const byLook = new Map<string, Thing[]>();
    for (const thing of all) {
        const key = `${thing.kind}:${flatten(thing.name)}`;
        byLook.set(key, [...byLook.get(key) ?? [], thing]);
    }
    for (const group of byLook.values()) {
        if (group.length > 1) for (const thing of group) thing.flags.push(`shares a name with ${group.length - 1} other`);
    }

    return all.sort((a, b) => b.flags.length - a.flags.length || b.at - a.at);
}

function Expressions({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.MANAGE_GUILD_EXPRESSIONS, guild);

    const [things, setThings] = useState<Thing[]>();
    const [noLog, setNoLog] = useState(false);
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    async function load() {
        const who = await makers(guild.id);
        setNoLog(who == null);
        return gather(guild, who);
    }

    useEffect(() => {
        let alive = true;
        load().then(found => { if (alive) setThings(found); });
        return () => { alive = false; };
    }, [guild.id]);

    const tick = (id: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const chosen = things?.filter(thing => ticked.has(thing.id)) ?? [];
    const flagged = things?.filter(thing => thing.flags.length).length ?? 0;

    async function remove() {
        setBusy(true);
        let done = 0;

        try {
            for (const thing of chosen) {
                await RestAPI.del({
                    url: thing.kind === "emoji"
                        ? `/guilds/${guild.id}/emojis/${thing.id}`
                        : `/guilds/${guild.id}/stickers/${thing.id}`
                });
                done++;
                setProgress(`deleted ${done} of ${chosen.length}`);
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
                    what: `Deleted ${plural(done, "emoji or sticker")}. The files are gone.`,
                    targets: []
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
            forget(`audit:${guild.id}`);
            setThings(await load());
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Emoji and stickers in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!things
                            ? "Reading..."
                            : things.length
                                ? `${plural(things.length, "thing")}, ${flagged} worth a look.`
                                : "Nothing added here."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Discord does not report how often one gets used, so this cannot tell you what
                        nobody reaches for. It shows who added what, and when.
                        {noLog && " You are missing View Audit Log, so there are no names against these."}
                    </Text>
                </div>

                {things && things.length > 0 && (
                    <>
                        <div className={cl("purge-pick")}>
                            <Text variant="text-sm/normal">{chosen.length} of {things.length} ticked</Text>
                            <div className={cl("safety-actions-right")}>
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
                            {things.map(thing => (
                                <div key={thing.id} className={cl("safety-row", { critical: thing.flags.length > 0 })}>
                                    <Checkbox
                                        value={ticked.has(thing.id)}
                                        onChange={() => tick(thing.id)}
                                        disabled={busy || !allowed}
                                        align="top"
                                    >
                                        <div className={cl("safety-title")}>
                                            {thing.name}
                                            <span className={cl("power-locked")}>{thing.kind}</span>
                                            {thing.animated && <span className={cl("power-locked")}>animated</span>}
                                        </div>
                                        <div className={cl("safety-detail")}>
                                            added {new Date(thing.at).toLocaleDateString()}
                                            {thing.by ? ` by ${thing.by}` : ""}
                                        </div>
                                        {thing.flags.length > 0 && <div className={cl("joins-flags")}>{list(thing.flags)}</div>}
                                    </Checkbox>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (!allowed ? "You need Manage Expressions here" : chosen.length ? `${plural(chosen.length, "thing")} ticked` : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Delete ${plural(chosen.length, "thing")}?`,
                                items: chosen.map(thing => thing.name),
                                warning: "Messages already using them lose the picture. There is no undo.",
                                verb: "Delete them",
                                onConfirm: () => void remove()
                            })}
                        >
                            Delete ticked
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openExpressionsModal(guild: Guild) {
    openModal(props => <Expressions guild={guild} modalProps={props} />);
}
