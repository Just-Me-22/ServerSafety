/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild } from "@vencord/discord-types";
import { Button, Text, TextInput, useState } from "@webpack/common";

import { openAllServersModal } from "./AllServers";
import { openArrivalModal } from "./Arrival";
import { openBanTransferModal } from "./BanTransfer";
import { openBroadcastModal } from "./Broadcast";
import { openBulkModal } from "./Bulk";
import { openChannelsModal } from "./Channels";
import { openCommunityModal } from "./Community";
import { openDeadWeightModal } from "./DeadWeight";
import { openDeleteImpactModal } from "./DeleteImpact";
import { openEmergencyModal } from "./Emergency";
import { openExpressionsModal } from "./Expressions";
import { openHistoryModal } from "./HistoryModal";
import { openImpostorsModal } from "./Impostors";
import { openInspectModal } from "./Inspect";
import { openInvitesModal } from "./InviteForensics";
import { openLadderModal } from "./Ladder";
import { openNicknamesModal } from "./Nicknames";
import { openPurgeModal } from "./Purge";
import { openRaidPanel } from "./RaidPanel";
import { openRecentJoinsModal } from "./RecentJoins";
import { openRoleDiffModal } from "./RoleDiff";
import { openRulesPanel } from "./RulesPanel";
import { openRunningModal } from "./Running";
import { openAutoSlowModal } from "./Slowmode";
import { openTimelineModal } from "./Timeline";
import { openUnbanModal } from "./Unban";
import { openWebhooksModal } from "./Webhooks";

const cl = classNameFactory("vc-ss-");

interface Tool {
    label: string;
    /** what it is for, so the filter matches how you think of it and not only its name */
    about: string;
    danger?: boolean;
    open: (guild: Guild) => void;
}

interface Group {
    title: string;
    tools: Tool[];
}

const GROUPS: Group[] = [
    {
        title: "Act now",
        tools: [
            { label: "Emergency", about: "lockdown panic raid verification invites dms", danger: true, open: openEmergencyModal },
            { label: "Clear messages", about: "purge delete spam flood", danger: true, open: openPurgeModal },
            { label: "Bring bans over", about: "import ban list transfer another server", danger: true, open: openBanTransferModal }
        ]
    },
    {
        title: "Runs on its own",
        tools: [
            { label: "What is running", about: "holds timers scheduled pending slowmode unban", open: openRunningModal },
            { label: "Auto slowmode", about: "flood quiet hours night schedule rate limit", open: openAutoSlowModal },
            { label: "Raid guard", about: "joins verification automatic raise", open: openRaidPanel },
            { label: "Tell me when", about: "audit log rules notify administrator webhook", open: openRulesPanel }
        ]
    },
    {
        title: "People",
        tools: [
            { label: "Recent joins", about: "new members arrivals flags invite", open: openRecentJoinsModal },
            { label: "Invites", about: "forensics which invite brought banned codes", open: openInvitesModal },
            { label: "Lookalikes", about: "impersonation staff copy name avatar", open: openImpostorsModal },
            { label: "Nicknames", about: "zalgo invisible hoisting tidy rename", open: openNicknamesModal },
            { label: "Bans", about: "unban ban list reasons bulk", open: openUnbanModal },
            { label: "Broadcast", about: "announce message post everyone", open: openBroadcastModal }
        ]
    },
    {
        title: "The server",
        tools: [
            { label: "Channels", about: "create edit private spoiler category stage", open: openChannelsModal },
            { label: "Community", about: "enable disable discovery rules updates", open: openCommunityModal },
            { label: "Compare roles", about: "diff permissions two roles", open: openRoleDiffModal },
            { label: "Delete a role", about: "impact who loses what before removing", open: openDeleteImpactModal },
            { label: "Role ladder", about: "who can hand out which roles manage", open: openLadderModal },
            { label: "Bulk changes", about: "slowmode strip permission every role channel", open: openBulkModal },
            { label: "Dead weight", about: "unused roles channels invites clean up", open: openDeadWeightModal },
            { label: "Webhooks", about: "delete created by left follower", open: openWebhooksModal },
            { label: "Emoji and stickers", about: "expressions added by duplicates", open: openExpressionsModal },
            { label: "First impression", about: "onboarding new arrival sees screening", open: openArrivalModal },
            { label: "Look around", about: "inspect browse channels permissions", open: openInspectModal }
        ]
    },
    {
        title: "Look back",
        tools: [
            { label: "History", about: "undo what I did log", open: openHistoryModal },
            { label: "What changed", about: "timeline drift snapshots over time", open: openTimelineModal },
            { label: "Check every server", about: "all servers audit sweep", open: openAllServersModal }
        ]
    }
];

export function Tools({ guild, onCopy }: { guild: Guild; onCopy: () => void; }) {
    const [filter, setFilter] = useState("");
    const wanted = filter.trim().toLowerCase();

    const matches = (tool: Tool) => `${tool.label} ${tool.about}`.toLowerCase().includes(wanted);

    const shown = wanted
        ? [{ title: "Matches", tools: GROUPS.flatMap(group => group.tools).filter(matches) }]
        : GROUPS;

    return (
        <div className={cl("tools")}>
            <div className={cl("tools-search")}>
                <TextInput value={filter} placeholder="Find a tool" onChange={setFilter} />
                <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={onCopy}>
                    Copy report
                </Button>
            </div>

            {shown.map(group => (
                <div key={group.title} className={cl("tools-group")}>
                    <Text variant="text-xs/semibold" className={cl("tools-heading")}>{group.title}</Text>
                    <div className={cl("safety-actions-right")}>
                        {group.tools.map(tool => (
                            <Button
                                key={tool.label}
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                className={tool.danger ? cl("safety-panic") : undefined}
                                onClick={() => tool.open(guild)}
                            >
                                {tool.label}
                            </Button>
                        ))}
                    </div>
                </div>
            ))}

            {wanted && !shown[0].tools.length && (
                <Text variant="text-sm/normal">Nothing here matches that.</Text>
            )}
        </div>
    );
}
