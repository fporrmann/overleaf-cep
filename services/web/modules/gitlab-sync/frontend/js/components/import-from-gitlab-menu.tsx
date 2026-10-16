import React from 'react'
import { useTranslation } from 'react-i18next'
import { OLDropdownItem } from '@/shared/components/ol/ol-dropdown-menu'
import { GIT_PROVIDER } from '../constants'

export default function ImportFromGitLabMenu({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <OLDropdownItem onClick={onClick}>
      {t('import_from_github', { gitProvider: GIT_PROVIDER })}
    </OLDropdownItem>
  )
}