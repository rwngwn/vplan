import type { AppProps } from 'next/app'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/react/style.css'
import '../styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
