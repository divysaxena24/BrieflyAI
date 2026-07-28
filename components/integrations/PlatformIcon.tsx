"use client";

import React from "react";
import {
  GmailMailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GithubIcon,
  SlackIcon,
  DiscordIcon,
  TelegramSendIcon,
  MessageIcon,
} from "@/components/dashboard/icons";

const platformIconMap: Record<string, React.FC<{ size?: number; className?: string }>> = {
  gmail: GmailMailIcon,
  "google-calendar": GoogleCalendarIcon,
  "google-drive": GoogleDriveIcon,
  github: GithubIcon,
  slack: SlackIcon,
  discord: DiscordIcon,
  telegram: TelegramSendIcon,
  whatsapp: MessageIcon,
};

interface PlatformIconProps {
  platformId: string;
  size?: number;
  className?: string;
}

export const PlatformIcon: React.FC<PlatformIconProps> = ({ platformId, size = 22, className }) => {
  const Icon = platformIconMap[platformId];
  if (!Icon) return null;
  return <Icon size={size} className={className} />;
};
