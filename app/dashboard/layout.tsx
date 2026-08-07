import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/actions";
import { DashboardLayout } from "@/components/dashboard";
import { IntegrationStoreProvider } from "@/lib/integrations/store";
import { BotTokenConnectDialog, WhatsAppConnectDialog, OAuthConnectDialog } from "@/components/integrations";

export default async function DashboardRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <DashboardLayout
      userEmail={user.email}
      userFullName={user.fullName}
      onSignOut={signOut}
    >
      <IntegrationStoreProvider>
        <BotTokenConnectDialog />
        <WhatsAppConnectDialog />
        <OAuthConnectDialog />
        {children}
      </IntegrationStoreProvider>
    </DashboardLayout>
  );
}
