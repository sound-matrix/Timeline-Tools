import "./globals.css";
export const metadata = {
  title: "Timeline Tools",
  description: "Audio clean-up, mastering and subtitles",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
