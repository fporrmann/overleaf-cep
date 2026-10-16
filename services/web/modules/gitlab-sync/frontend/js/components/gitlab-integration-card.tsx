import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectContext } from '@/shared/context/project-context'
import GitLabLogo from '@/shared/svgs/gitlab-logo'
import IntegrationCard from '@/features/integrations-panel/integration-card'
import GitSyncModal from './modals/git-sync-modal'
import { GitSyncModalStatus } from '../types/git-sync-types'
import { GIT_PROVIDER } from '../constants'

const GitLabSyncCard = () => {
  const { t } = useTranslation()

  const [showModal, setShowModal] = useState(false)
  const { projectId, name } = useProjectContext()
  const [modalStatus, setModalStatus] = useState<GitSyncModalStatus>('loading')

  return (
    <>
      <IntegrationCard
        title={t('github', { gitProvider: GIT_PROVIDER })}
        description={t('sync_with_a_github_repository', { gitProvider: GIT_PROVIDER })}
        icon={<GitLabLogo size={32} />}
        showPaywallBadge={false}
        onClick={() => setShowModal(true)}
      >
      </IntegrationCard>
      <GitSyncModal
        show={showModal}
        modalStatus={modalStatus}
        setModalStatus={setModalStatus}
        handleHide={() => {
          setShowModal(false)
          setModalStatus('loading')
        }}
        projectId={projectId}
        projectName={name}
      />
    </>
  )
}

export default GitLabSyncCard
