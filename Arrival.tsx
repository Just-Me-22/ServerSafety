/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Forms, GuildRoleStore, Modal, openModal, RestAPI, ScrollerThin, Text, useEffect, useState } from "@webpack/common";

import { everyoneIn, guildChannels, has, list, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const LEVELS = [
    "anyone at all",
    "a verified email",
    "a verified email and five minutes of membership",
    "a verified email and ten minutes in this server",
    "a verified phone number"
];

interface Onboarding {
    enabled?: boolean;
    mode?: number;
    prompts?: { title: string; options?: { title: string; }[]; }[];
    default_channel_ids?: string[];
}

interface Seen {
    channels: string[];
    postable: string[];
    rules: string | null;
    onboarding: Onboarding | null;
    screening: boolean;
}

async function look(guild: Guild): Promise<Seen> {
    const everyone = GuildRoleStore.getSortedRoles(guild.id).find(role => role.id === guild.id);
    const base = everyone?.permissions ?? 0n;

    const visible = guildChannels(guild.id).filter(channel => has(everyoneIn(channel, guild.id, base), "VIEW_CHANNEL"));
    const postable = visible.filter(channel => has(everyoneIn(channel, guild.id, base), "SEND_MESSAGES"));

    let onboarding: Onboarding | null = null;
    try {
        const { body } = await RestAPI.get({ url: `/guilds/${guild.id}/onboarding` });
        onboarding = body as Onboarding;
    } catch {
        onboarding = null;
    }

    const rulesId = (guild as any).rulesChannelId ?? null;

    return {
        channels: visible.map(channel => channel.name),
        postable: postable.map(channel => channel.name),
        rules: rulesId ? visible.find(channel => channel.id === rulesId)?.name ?? null : null,
        onboarding,
        screening: guild.features.has("MEMBER_VERIFICATION_GATE_ENABLED")
    };
}

function Arrival({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [seen, setSeen] = useState<Seen>();

    useEffect(() => {
        let alive = true;
        look(guild).then(found => { if (alive) setSeen(found); });
        return () => { alive = false; };
    }, [guild.id]);

    const steps = seen?.onboarding?.enabled ? seen.onboarding.prompts ?? [] : [];

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">What a new arrival sees in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!seen
                            ? "Working it out..."
                            : `They land in ${plural(seen.channels.length, "channel")} and can talk in ${seen.postable.length}.`}
                    </Text>
                    <Text variant="text-sm/normal">
                        This is what someone with no roles gets, which is what everyone gets on their
                        first second here.
                    </Text>
                </div>

                {seen && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        <div className={cl("safety-row")}>
                            <div className={cl("safety-title")}>To get in at all they need</div>
                            <div className={cl("safety-detail")}>
                                {LEVELS[guild.verificationLevel] ?? "something"}
                                {seen.screening ? ", and they have to accept the rules first" : ""}
                                {!seen.screening && seen.rules ? `. #${seen.rules} is set as the rules channel but screening is off, so nobody is made to read it` : ""}
                            </div>
                        </div>

                        <div className={cl("safety-row", { critical: steps.length === 0 })}>
                            <div className={cl("safety-title")}>
                                {steps.length ? `${plural(steps.length, "question")} before they are through` : "No onboarding questions"}
                            </div>
                            <div className={cl("safety-detail")}>
                                {steps.length
                                    ? steps.map(step => (
                                        <div key={step.title}>
                                            {step.title}: {list((step.options ?? []).map(option => option.title))}
                                        </div>
                                    ))
                                    : "they go straight in, so nothing filters or sorts them"}
                            </div>
                        </div>

                        <div className={cl("safety-row")}>
                            <div className={cl("safety-title")}>They can see {plural(seen.channels.length, "channel")}</div>
                            <div className={cl("safety-detail")}>{list(seen.channels.map(name => `#${name}`))}</div>
                        </div>

                        <div className={cl("safety-row", { critical: seen.postable.length > 5 })}>
                            <div className={cl("safety-title")}>They can talk in {plural(seen.postable.length, "channel")}</div>
                            <div className={cl("safety-detail")}>
                                {seen.postable.length
                                    ? list(seen.postable.map(name => `#${name}`))
                                    : "nowhere, so they have to be given a role first"}
                            </div>
                        </div>
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openArrivalModal(guild: Guild) {
    openModal(props => <Arrival guild={guild} modalProps={props} />);
}
