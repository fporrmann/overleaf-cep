import { useTranslation, Trans } from 'react-i18next'
import OLNotification from '@/shared/components/ol/ol-notification'
import {
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import { ProjectSyncState } from '../../types/git-sync-types'
import getMeta from '@/utils/meta'

type GitSyncNeedPermissionModalProps = {
  projectSyncState: ProjectSyncState
  handleHide: () => void
}

const GitSyncNeedPermissionModal = ({ projectSyncState, handleHide }: GitSyncNeedPermissionModalProps) => {
  const { t } = useTranslation()
  let giteaUrl = getMeta('ol-ExposedSettings').giteaUrl || ''

  return (
    <>
      <OLModalBody>
        <OLNotification
          type="warning"
          content={(
            <Trans
              i18nKey="ask_proj_owner_to_add_you_as_gitea_collaborator"
              values={{
                repoFullName: projectSyncState.repoFullName ?? '?',
                projectOwnerEmail: projectSyncState.ownerEmail ?? '?',
              }}
              components={[
                projectSyncState.repoFullName ? (
                  <a
                    href={`${giteaUrl}/${projectSyncState.repoFullName}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  />
                ) : (
                  <></>
                ),
                projectSyncState.ownerEmail ? <a href={`mailto:${projectSyncState.ownerEmail}`} /> : <></>
              ]}
            />
          )}
        />
      </OLModalBody>
      <OLModalFooter>
        <OLButton
          variant="secondary"
          onClick={handleHide}
        >
          {t('close')}
        </OLButton>
      </OLModalFooter>
    </>
  )
}

export default GitSyncNeedPermissionModal
