import "./globals.css";
import { themeCss } from "../public/theme.js";
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
      <head>
        <style>{themeCss}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
