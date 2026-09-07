/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildRoleStore, Modal, openModal, Select, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { adminRolesOf, ban, canActOn, displayName, isQuarantined, kick, myPermissions, quarantine, release, savedQuarantineRole, setupQuarantine, timeout, warn } from "./moderation";
import { has, list, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

/** Discord refuses a timeout longer than 28 days, so that is the last option */
const MINUTES = [5, 10, 60, 24 * 60, 7 * 24 * 60, 28 * 24 * 60];
const minuteLabel = (m: number) => m < 60 ? plural(m, "minute") : m < 1440 ? plural(m / 60, "hour") : plural(m / 1440, "day");

/** this is how much of their posting to wipe, not how long the ban lasts. Discord
 *  bans have no duration at all, and 7 days is the most it will delete */
const PURGE = [
    { label: "Keep their posts", value: 0 },
    { label: "Wipe their last hour", value: 3600 },
    { label: "Wipe their last day", value: 86400 },
    { label: "Wipe their last week", value: 604800 }
];

function Action({ title, detail, note, tone, children }: {
    title: string;
    detail: string;
    note?: string;
    tone?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cl("punish-cell", tone)}>
            <div className={cl("punish-head")}>
                <div className={cl("safety-title")}>{title}</div>
                <div className={cl("punish-controls")}>{children}</div>
            </div>
            <div className={cl("safety-detail")}>{detail}</div>
            {note && <div className={cl("joins-flags")}>{note}</div>}
        </div>
    );
}

function Punish({ guild, userId, modalProps }: { guild: Guild; userId: string; modalProps: RenderModalProps; }) {
    const name = displayName(guild, userId);
    const mine = myPermissions(guild);
    const allowed = canActOn(guild, userId);

    const [reason, setReason] = useState("");
    const [minutes, setMinutes] = useState(60);
    const [purge, setPurge] = useState(0);
    const [busy, setBusy] = useState(false);
    const [roleId, setRoleId] = useState<string | null>();
    const [progress, setProgress] = useState<string>();

    useEffect(() => {
        let live = true;
        savedQuarantineRole(guild.id).then(id => { if (live) setRoleId(id); });
        return () => { live = false; };
    }, [guild.id]);

    // the id is remembered on disk, so check the role still exists before offering it
    const liveRoleId = roleId && GuildRoleStore.getRole(guild.id, roleId) ? roleId : roleId === undefined ? undefined : null;
    const held = isQuarantined(guild, userId, liveRoleId ?? null);
    const admins = adminRolesOf(guild, userId);

    async function run(label: string, action: () => Promise<void>) {
        setBusy(true);
        try {
            await action();
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: label });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
            setBusy(false);
        }
    }

    const confirm = (title: string, body: string, label: string, action: () => Promise<void>) =>
        Alerts.show({
            title,
            body: <p>{body}</p>,
            confirmText: label,
            confirmColor: Button.Colors.RED,
            cancelText: "Cancel",
            onConfirm: () => run(`${label} done`, action)
        });

    async function makeQuarantine() {
        setBusy(true);
        try {
            const existing = GuildRoleStore.getSortedRoles(guild.id).find(role => role.name === "Quarantined");
            const id = await setupQuarantine(guild, existing?.id ?? null, (done, total) => setProgress(`Locking channel ${done} of ${total}`));
            setRoleId(id);
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Quarantine role is ready" });
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setProgress(undefined);
            setBusy(false);
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">What to do about {name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {allowed
                            ? "Everything here is written to History and can be undone, except a kick."
                            : `You cannot act on ${name}. They match or outrank you.`}
                    </Text>
                    <Text variant="text-sm/normal">A reason goes into the server's audit log, where the rest of your staff can read it.</Text>
                    <div className={cl("punish-reason")}>
                        <TextInput
                            value={reason}
                            placeholder="Reason, optional but everyone else will thank you"
                            onChange={setReason}
                        />
                    </div>
                </div>

                <div className={cl("punish-grid")}>
                    <Action title="Time out" detail="They can read but not talk. Expires on its own.">
                        <div className={cl("punish-select")}>
                            <Select
                                options={MINUTES.map(m => ({ label: minuteLabel(m), value: m }))}
                                select={setMinutes}
                                isSelected={value => value === minutes}
                                serialize={String}
                            />
                        </div>
                        <Button
                            size={Button.Sizes.SMALL}
                            className={cl("punish-go")}
                            disabled={busy || !allowed || !has(mine, "MODERATE_MEMBERS")}
                            onClick={() => confirm("Time them out?", `${name} will not be able to talk for ${minuteLabel(minutes)}.`, "Time out", () => timeout(guild, userId, minutes))}
                        >
                            Time out
                        </Button>
                    </Action>

                    <Action title="Warn" detail="Sends the reason above to them as a direct message.">
                        <Button
                            size={Button.Sizes.SMALL}
                            className={cl("punish-go")}
                            disabled={busy || !reason.trim()}
                            onClick={() => confirm("Send this warning?", `${name} will get a DM saying: ${reason}`, "Send", () => warn(guild, userId, reason))}
                        >
                            Send DM
                        </Button>
                    </Action>

                    <Action
                        title="Quarantine"
                        tone="punish-warn"
                        detail={liveRoleId === undefined
                            ? "Checking whether this server already has a quarantine role."
                            : liveRoleId
                                ? "Adds a role that is denied everything in every channel. Does not expire."
                                : "Needs a one time setup: one role, then a deny in every channel."}
                        note={progress ?? (admins.length
                            ? `${list(admins.map(role => role!.name))} grants Administrator, which ignores channel overrides, so quarantine will not hold them.`
                            : undefined)}
                    >
                        {liveRoleId
                            ? (
                                <Button
                                    size={Button.Sizes.SMALL}
                                    className={cl("punish-go")}
                                    disabled={busy || !allowed || !has(mine, "MANAGE_ROLES")}
                                    onClick={() => held
                                        ? run("Released", () => release(guild, userId, liveRoleId))
                                        : confirm("Quarantine them?", `${name} will lose access to every channel until you release them.`, "Quarantine", () => quarantine(guild, userId, liveRoleId))}
                                >
                                    {held ? "Release" : "Quarantine"}
                                </Button>
                            )
                            : (
                                <Button
                                    size={Button.Sizes.SMALL}
                                    className={cl("punish-go")}
                                    disabled={busy || liveRoleId === undefined || !has(mine, "MANAGE_ROLES")}
                                    onClick={makeQuarantine}
                                >
                                    Set it up
                                </Button>
                            )}
                    </Action>

                    <Action
                        title="Kick"
                        tone="punish-danger"
                        detail="They can come back with a new invite. This is the one thing here that cannot be undone."
                    >
                        <Button
                            size={Button.Sizes.SMALL}
                            className={cl("punish-go")}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !has(mine, "KICK_MEMBERS")}
                            onClick={() => confirm("Kick them?", `${name} will be removed. They can rejoin with any working invite, and this cannot be undone.`, "Kick", () => kick(guild, userId, reason))}
                        >
                            Kick
                        </Button>
                    </Action>

                    <Action
                        title="Ban, permanently"
                        tone="punish-danger"
                        detail="A Discord ban has no end date. It stands until somebody lifts it, and Undo in History is one way to do that. The dropdown is how much of their recent posting to wipe on the way out, not how long the ban lasts, and a week is the most Discord will delete."
                    >
                        <div className={cl("punish-select")}>
                            <Select
                                options={PURGE}
                                select={setPurge}
                                isSelected={value => value === purge}
                                serialize={String}
                            />
                        </div>
                        <Button
                            size={Button.Sizes.SMALL}
                            className={cl("punish-go")}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !has(mine, "BAN_MEMBERS")}
                            onClick={() => confirm("Ban them for good?", `${name} will be banned with no end date, and this will ${PURGE.find(p => p.value === purge)?.label.toLowerCase()}.`, "Ban", () => ban(guild, userId, reason, purge))}
                        >
                            Ban
                        </Button>
                    </Action>
                </div>
            </div>
        </Modal>
    );
}

export function openPunishModal(guild: Guild, userId: string) {
    openModal(props => <Punish guild={guild} userId={userId} modalProps={props} />);
}

/** true when this account can do anything at all to somebody here, used to decide
 *  whether the button is worth showing */
export const canModerate = (guild: Guild) => {
    const mine = myPermissions(guild);
    return has(mine, "BAN_MEMBERS") || has(mine, "KICK_MEMBERS") || has(mine, "MODERATE_MEMBERS") || has(mine, "MANAGE_ROLES");
};
