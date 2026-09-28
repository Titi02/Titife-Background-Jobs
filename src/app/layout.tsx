import "./globals.css";
import { ReactNode } from "react";

export const metadata = {
  title: "Background Job Processing System",
  description: "Send transactional emails and monitor background job queues",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
