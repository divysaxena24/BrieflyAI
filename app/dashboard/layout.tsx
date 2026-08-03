import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/actions";
import { DashboardLayout } from "@/components/dashboard";
import { IntegrationStoreProvider } from "@/lib/integrations/store";
import { BotTokenConnectDialog, WhatsAppConnectDialog } from "@/components/integrations";

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
        {children}
      </IntegrationStoreProvider>
    </DashboardLayout>
  );
}
