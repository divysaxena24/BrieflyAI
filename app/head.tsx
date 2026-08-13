import Script from "next/script";

export default function Head() {
  return (
    <>
      {/* Theme init script runs before hydration to prevent FOUC */}
      <Script
        id="theme-init"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              try {
                var theme = localStorage.getItem('theme');
                var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                var useDark = theme === 'dark' || ((theme === 'system' || !theme) && prefersDark);
                if (useDark) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.remove('dark');
                }
              } catch(e) {}
            })();
          `,
        }}
      />
    </>
  );
}
