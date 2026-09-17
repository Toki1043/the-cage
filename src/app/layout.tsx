import type { Metadata } from 'next'
import { Anton, Archivo } from 'next/font/google'
import './globals.css'

/**
 * Te same dwa fonty co w prototypie (Anton na nagłówki, Archivo na tekst),
 * ale przez next/font zamiast <link> do Google Fonts: pliki lądują na naszym
 * hoście, więc nie ma osobnego połączenia ani przeskoku tekstu przy wczytaniu.
 * next/font hashuje nazwę rodziny, dlatego CSS sięga po zmienne.
 */
const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-anton',
})

const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-archivo',
})

export const metadata: Metadata = {
  title: 'Tale of the Tape — two contracts, one fight',
  description:
    'Two contracts, four stats each, three rounds. The numbers decide who wins — the commentary team just has to watch it happen.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${anton.variable} ${archivo.variable}`}>
      <body>{children}</body>
    </html>
  )
}
