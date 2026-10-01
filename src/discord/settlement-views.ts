import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { SessionDto } from "../application/types.js";
import type { SettlementPreviewDto, SettlementSnapshotDto } from "../application/settlement-service.js";
import type { ReminderSettingDto } from "../application/reminder-service.js";
import type { ReminderDraft } from "./reminder-drafts.js";
import { makeCustomId } from "./custom-id.js";

const id = (action: string, s: SessionDto, arg = "") => makeCustomId(action, s.id, s.revision, arg);
const button = (label: string, customId: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);
const memberName = (s: SessionDto, memberId: string) => { const m = s.members.find((x) => x.id === memberId); return m ? `<@${m.discordUserId}>` : "参加者"; };

export function previewView(s: SessionDto, preview: SettlementPreviewDto, actor: string, page = 0) {
  const pages = Math.max(1, Math.ceil(Math.max(preview.balances.length, preview.transfers.length) / 10));
  const p = Math.max(0, Math.min(page, pages - 1));
  const balances = preview.balances.slice(p * 10, p * 10 + 10);
  const transfers = preview.transfers.slice(p * 10, p * 10 + 10);
  const body = [
    "【負担と立替】",
    balances.map((b) => `${memberName(s, b.memberId)} · 負担 ${b.shareAmount.toLocaleString()}円 · 立替 ${b.paidAmount.toLocaleString()}円 · ${b.balance > 0 ? "受取" : b.balance < 0 ? "支払" : "精算不要"} ${Math.abs(b.balance).toLocaleString()}円`).join("\n") || "該当なし",
    "【送金予定】",
    transfers.map((t) => `${memberName(s, t.fromMemberId)} → ${memberName(s, t.toMemberId)} · ${t.amount.toLocaleString()}円`).join("\n") || "送金はありません。",
  ].join("\n\n");
  const embed = new EmbedBuilder().setTitle("精算プレビュー").setDescription(`合計 ${preview.totalAmount.toLocaleString()}円\n\n${body}`).setFooter({ text: `確定予定 第${preview.nextVersion}版 · ${p + 1}/${pages}ページ · 更新番号 ${s.revision}` });
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("前へ", id("ppage", s, `${Math.max(0, p - 1).toString(36)}_prev`)).setDisabled(p === 0), button("次へ", id("ppage", s, `${Math.min(pages - 1, p + 1).toString(36)}_next`)).setDisabled(p >= pages - 1)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(...(s.creatorDiscordUserId === actor ? [button("精算を確定", id("finalize", s), ButtonStyle.Danger)] : []), button("詳細へ戻る", id("page", s))),
  ];
  return { embeds: [embed], components };
}

export function settlementView(s: SessionDto, settlement: SettlementSnapshotDto, page: number, actor: string) {
  const pages = Math.max(1, Math.ceil(settlement.transfers.length / 10)); const p = Math.max(0, Math.min(page, pages - 1));
  const transfers = settlement.transfers.slice(p * 10, p * 10 + 10);
  const unpaid = settlement.transfers.filter((t)=>t.status === "UNPAID").length;
  const controls: ActionRowBuilder<any>[] = transfers.length ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(id("transfer", s, `${settlement.id.replaceAll("-", "")}_${p.toString(36)}`)).setPlaceholder("送金を選択").addOptions(transfers.map((t) => ({ label: `${memberName(s,t.fromMemberId)} → ${memberName(s,t.toMemberId)} · ${t.amount.toLocaleString()}円`, value: t.id.replaceAll("-", ""), description: t.status === "PAID" ? "支払済み" : "未払い" }))))] : [];
  controls.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("残高", id("balances", s, settlement.id.replaceAll("-", "")), ButtonStyle.Primary), button("前へ", id("settlement", s, `${settlement.id.replaceAll("-", "")}_${Math.max(0,p-1).toString(36)}_prev`)).setDisabled(p===0), button("次へ", id("settlement", s, `${settlement.id.replaceAll("-", "")}_${Math.min(pages-1,p+1).toString(36)}_next`)).setDisabled(p>=pages-1)));
  if (s.status === "SETTLING" && s.creatorDiscordUserId === actor) controls.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("リマインド", id("reminder",s), ButtonStyle.Primary), button("精算を解除", id("invalidate",s,settlement.id.replaceAll("-","")), ButtonStyle.Danger), ...(unpaid === 0 ? [button("完了", id("close",s,settlement.id.replaceAll("-","")), ButtonStyle.Success)] : [])));
  controls.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("詳細へ戻る", id("page",s))));
  const embed = new EmbedBuilder().setTitle(`精算 第${settlement.version}版 · ${settlement.status === "FINALIZED" ? "確定" : "無効"}`).setDescription(`合計 ${settlement.totalAmount.toLocaleString()}円 · 未払い ${unpaid}件\n` + (transfers.map((t)=>`${t.status === "PAID" ? "✅" : "▫️"} ${memberName(s,t.fromMemberId)} → ${memberName(s,t.toMemberId)} · ${t.amount.toLocaleString()}円`).join("\n") || "送金はありません。")).setFooter({text:`${settlement.transfers.length}件 · ${p+1}/${pages}ページ`});
  return { embeds:[embed], components:controls };
}

export function balancesView(s: SessionDto, settlement: SettlementSnapshotDto, page = 0) {
  const pages = Math.max(1, Math.ceil(settlement.balances.length / 10));
  const p = Math.max(0, Math.min(page, pages - 1));
  const balances = settlement.balances.slice(p * 10, p * 10 + 10);
  const embed = new EmbedBuilder().setTitle("精算残高").setDescription(balances.map((b)=>`${memberName(s,b.memberId)} · 負担 ${b.shareAmount.toLocaleString()}円 · 立替 ${b.paidAmount.toLocaleString()}円 · 残高 ${b.balance.toLocaleString()}円`).join("\n") || "残高はありません").setFooter({text:`${p+1}/${pages}ページ`});
  return {embeds:[embed],components:[new ActionRowBuilder<ButtonBuilder>().addComponents(button("前へ",id("balances",s,`${settlement.id.replaceAll("-","")}_${Math.max(0,p-1).toString(36)}_prev`)).setDisabled(p===0),button("次へ",id("balances",s,`${settlement.id.replaceAll("-","")}_${Math.min(pages-1,p+1).toString(36)}_next`)).setDisabled(p>=pages-1),button("送金一覧へ",id("settlement",s,`${settlement.id.replaceAll("-","")}_0`)))]};
}

export function transferActionView(s: SessionDto, settlement: SettlementSnapshotDto, transferId: string) {
  const transfer = settlement.transfers.find((t) => t.id.replaceAll("-", "") === transferId);
  if (!transfer) throw new Error("Transfer is no longer available.");
  const isPaid = transfer.status === "PAID";
  return { embeds: [new EmbedBuilder().setTitle("送金状況").setDescription(`${memberName(s,transfer.fromMemberId)} → ${memberName(s,transfer.toMemberId)}\n${transfer.amount.toLocaleString()}円 · ${isPaid ? "支払済み" : "未払い"}`)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(isPaid ? "未払いに戻す" : "支払済みにする", id(isPaid ? "unpaid" : "paid", s, transferId), isPaid ? ButtonStyle.Secondary : ButtonStyle.Success), button("送金一覧へ", id("settlement",s,`${settlement.id.replaceAll("-","")}_0`))) ] };
}

export function reminderView(s: SessionDto, settlement: SettlementSnapshotDto, setting: ReminderSettingDto | null, actor: string) {
  const formatTime = (value: number | null) => value === null ? "未設定" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  const hasUnpaid = settlement.transfers.some((transfer) => transfer.status === "UNPAID");
  const state = setting?.enabled ? "期限待ち" : setting?.lastReminderAt ? "送信済み" : "停止中";
  const text = setting ? `通知先 <#${setting.channelId}>\n状態: ${state}\n通知期限: ${formatTime(setting.firstReminderAt)}\n送信日時: ${formatTime(setting.lastReminderAt)}` : "期限日時と通知先を設定すると、期限に一度だけ通知します。";
  const rows: ActionRowBuilder<any>[] = [new ActionRowBuilder<ButtonBuilder>().addComponents(button("送金一覧",id("settlement",s,`${settlement.id.replaceAll("-","")}_0`)))];
  if (actor === s.creatorDiscordUserId) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("通知期限を設定",id("remedit",s,settlement.id.replaceAll("-","")),ButtonStyle.Success).setDisabled(!hasUnpaid || (setting !== null && setting.lastReminderAt !== null)), ...(setting?.enabled ? [button("通知を停止",id("remstop",s,settlement.id.replaceAll("-","")),ButtonStyle.Danger)] : [])));
  return {embeds:[new EmbedBuilder().setTitle("リマインド").setDescription(text)],components:rows};
}

export function reminderDraftView(s: SessionDto,d: ReminderDraft) {
  const cmd=(a:string)=>makeCustomId(a,s.id,s.revision,`${d.token}_${d.generation.toString(36)}`);
  return {embeds:[new EmbedBuilder().setTitle("リマインド設定").setDescription(`通知先: ${d.channelId ? `<#${d.channelId}>` : "未選択"}\n通知期限: ${d.firstReminderText || "未入力"}\n期限に一度だけ通知します。`)],components:[new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(cmd("remchannel")).setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setPlaceholder("通知先チャンネルを選択")),new ActionRowBuilder<ButtonBuilder>().addComponents(button("通知期限を入力",cmd("remfields"),ButtonStyle.Primary),button("保存",cmd("remsave"),ButtonStyle.Success),button("キャンセル",cmd("remcancel"),ButtonStyle.Danger))]};
}

export function reminderFieldsModal(customId:string,d:ReminderDraft):ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle("通知期限").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("first").setLabel("通知期限 JST (YYYY-MM-DD HH:mm)").setStyle(TextInputStyle.Short).setMaxLength(16).setValue(d.firstReminderText).setRequired(true)));
}
