/**
 * Icon central provider prioritizing Hugeicons React library with fallback to Lucide React.
 */

// Import Lucide React fallback icons
import {
  LayoutDashboard,
  Bot,
  FileText,
  Blocks,
  Bell,
  Settings,
  Zap,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Menu,
  Sun,
  Moon,
  Search,
  ChevronRight,
  MessageSquare,
  Clock,
  Link2,
  Mail,
  Send,
  Calendar,
  ArrowRight,
  TrendingUp,
  Activity,
  CheckCircle2,
  Code2,
  MessageCircle,
  HardDrive,
  Loader2,
  RefreshCw,
  ExternalLink,
  WifiOff,
  AlertTriangle,
  Lock,
  Plug,
  Layers,
  BarChart3,
  ListChecks,
  Network,
  Cpu,
  Globe,
} from "lucide-react";

// Try importing Hugeicons React icons dynamically/safely
let HugeIcons: any = {};
try {
  // @ts-ignore
  HugeIcons = require("@hugeicons/react");
} catch (e) {
  try {
    // @ts-ignore
    HugeIcons = require("hugeicons-react");
  } catch (err) {
    HugeIcons = {};
  }
}

/** Helper function to get Hugeicon if available, else Lucide icon fallback */
function resolveIcon(hugeIconNames: string[], lucideFallback: any) {
  for (const name of hugeIconNames) {
    if (HugeIcons && HugeIcons[name]) {
      return HugeIcons[name];
    }
  }
  return lucideFallback;
}

// Navigation & Dashboard Icons (Hugeicons first, Lucide fallback)
export const DashboardIcon = resolveIcon(["DashboardSquare01Icon", "Dashboard01Icon", "DashboardSquare02Icon", "Layout01Icon"], LayoutDashboard);
export const AiAgentIcon = resolveIcon(["BotIcon", "AiBrain01Icon", "ArtificialIntelligence01Icon", "SmartPhone01Icon"], Bot);
export const BriefingsIcon = resolveIcon(["FileText01Icon", "News01Icon", "Task01Icon", "Invoice01Icon"], FileText);
export const IntegrationsIcon = resolveIcon(["ApiIcon", "PluginsIcon", "Grid01Icon", "Software01Icon"], Blocks);
export const AlertsIcon = resolveIcon(["Notification01Icon", "Bell01Icon", "Alert01Icon"], Bell);
export const SettingsIcon = resolveIcon(["Settings01Icon", "Settings02Icon", "Sliders01Icon"], Settings);

// Feature & Action Icons
export const UpgradeZapIcon = resolveIcon(["FlashIcon", "ZapIcon", "EnergyIcon"], Zap);
export const AiSparklesIcon = resolveIcon(["SparklesIcon", "MagicWand01Icon", "StarsIcon"], Sparkles);
export const CollapseLeftIcon = resolveIcon(["SidebarLeftIcon", "ArrowLeft01Icon"], PanelLeftClose);
export const ExpandRightIcon = resolveIcon(["SidebarRightIcon", "ArrowRight01Icon"], PanelLeftOpen);
export const SignOutIcon = resolveIcon(["Logout01Icon", "Logout02Icon"], LogOut);
export const MobileMenuIcon = resolveIcon(["Menu01Icon", "Menu02Icon"], Menu);
export const ThemeSunIcon = resolveIcon(["Sun01Icon", "Sun02Icon"], Sun);
export const ThemeMoonIcon = resolveIcon(["Moon01Icon", "Moon02Icon"], Moon);
export const QuickSearchIcon = resolveIcon(["Search01Icon", "Search02Icon"], Search);
export const BreadcrumbChevronIcon = resolveIcon(["ChevronRightIcon", "ArrowRight01Icon"], ChevronRight);

// Platform & Stats Icons
export const GmailMailIcon = resolveIcon(["Mail01Icon", "Mail02Icon"], Mail);
export const MessageIcon = resolveIcon(["Comment01Icon", "Message01Icon"], MessageSquare);
export const TelegramSendIcon = resolveIcon(["TelegramIcon", "Send01Icon"], Send);
export const OutlookCalendarIcon = resolveIcon(["Calendar01Icon", "Calendar02Icon font"], Calendar);
export const GoogleCalendarIcon = resolveIcon(["Calendar02Icon", "Calendar01Icon"], Calendar);
export const GithubIcon = resolveIcon(["GithubIcon", "BrandGithubIcon"], Code2);
export const DiscordIcon = resolveIcon(["DiscordIcon", "GameIcon"], MessageCircle);
export const GoogleDriveIcon = resolveIcon(["DriveIcon", "FolderCloudIcon"], HardDrive);
export const ClockReminderIcon = resolveIcon(["Clock01Icon", "Clock02Icon"], Clock);
export const PlatformLinkIcon = resolveIcon(["Link01Icon", "Link02Icon"], Link2);
export const ArrowRightIcon = resolveIcon(["ArrowRight01Icon", "ArrowRight02Icon"], ArrowRight);
export const TrendingUpIcon = resolveIcon(["Analytics01Icon", "TrendingUpIcon"], TrendingUp);
export const ActivityStreamIcon = resolveIcon(["Activity01Icon", "Pulse01Icon"], Activity);
export const CheckCircleIcon = resolveIcon(["CheckCircle01Icon", "CheckMarkCircle01Icon"], CheckCircle2);

// Utility Icons (re-exported directly for integration components)
export const Loader2Icon = Loader2;
export const RefreshCwIcon = RefreshCw;
export const ExternalLinkIcon = ExternalLink;
export const WifiOffIcon = WifiOff;
export const AlertTriangleIcon = AlertTriangle;
export const LockIcon = Lock;
export const PlugIcon = Plug;
export const MailIcon = Mail;
export const GlobeIcon = Globe;

// Overview dashboard utility icons
export const LayersIcon = resolveIcon(["LayersIcon", "StackIcon"], Layers);
export const BarChart3Icon = resolveIcon(["BarChartIcon", "ChartIcon"], BarChart3);
export const ListChecksIcon = resolveIcon(["ListCheckIcon", "CheckListIcon"], ListChecks);
export const NetworkIcon = resolveIcon(["NetworkIcon", "NodesIcon"], Network);
export const CpuIcon = resolveIcon(["CpuIcon", "ProcessorIcon"], Cpu);
