import "./globals.css";

export const metadata = {
  title: "Casa Court",
  description: "King & Queen of the Court -- live event console",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
