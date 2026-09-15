{{- define "dnsmonitor.name" -}}
{{- printf "%s-dnsmonitor" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- define "dnsmonitor.image" -}}
{{- if .Values.image.digest -}}{{ .Values.image.repository }}@{{ .Values.image.digest }}{{- else -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}
{{- end -}}
{{- define "dnsmonitor.dbEnv" -}}
- name: DATABASE_HOST
  value: {{ ternary (printf "%s-db" (include "dnsmonitor.name" .)) .Values.database.host .Values.database.bundled | quote }}
- name: DATABASE_PORT
  value: {{ .Values.database.port | quote }}
- name: DATABASE_NAME
  value: {{ .Values.database.name | quote }}
- name: DATABASE_USER
  value: {{ .Values.database.user | quote }}
- name: DATABASE_PASSWORD_FILE
  value: /run/secrets/database-password
- name: BOOTSTRAP_TIMEOUT_SECONDS
  value: {{ .Values.migration.timeoutSeconds | quote }}
{{- end -}}
{{- define "dnsmonitor.security" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
{{- define "dnsmonitor.secretVolume" -}}
- name: app-secrets
  secret:
    secretName: {{ required "existingSecret is required" .Values.existingSecret }}
    defaultMode: 0440
    items:
      - key: database-password
        path: database-password
      - key: encryption-key
        path: encryption-key
{{- end -}}
