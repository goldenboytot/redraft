export function isAdminId(userId: string | null | undefined, allowlist = process.env.REDRAFT_ADMIN_USER_IDS) {
  return !!userId && (allowlist || "").split(",").map((id) => id.trim()).filter(Boolean).includes(userId);
}

export function validOutputPath(file: { user_id: string; session_id: string; storage_path: string }) {
  const parts = file.storage_path.split("/");
  return parts.length === 3 && parts[0] === file.user_id && parts[1] === file.session_id
    && /^[a-zA-Z0-9_-]+\.docx$/.test(parts[2]);
}
