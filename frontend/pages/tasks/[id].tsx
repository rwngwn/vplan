import { GetServerSideProps } from 'next'

export const getServerSideProps: GetServerSideProps = async ({ params }) => {
  const id = typeof params?.id === 'string' ? params.id : ''

  return {
    redirect: {
      destination: `/dashboard${id ? `?task=${encodeURIComponent(id)}` : ''}`,
      permanent: false,
    },
  }
}

export default function TaskRedirect() {
  return null
}
