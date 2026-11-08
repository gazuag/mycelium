import { useEffect, useState } from 'react';
import {
  prepareProfilePicture,
  validateProfileImageFile,
  type IdentityProfilePicture,
  type ProfileImageInfo,
  type ProfilePictureCrop
} from '../utils/profile-picture';
import { AVATAR_SIZES, IdentityAvatar } from './IdentityAvatar';

interface ProfilePictureEditorProps {
  seed: string;
  picture?: IdentityProfilePicture | null;
  onChange: (picture: IdentityProfilePicture | null) => void;
}

const CENTER_CROP: ProfilePictureCrop = { x: 0.5, y: 0.5, zoom: 1 };

export function ProfilePictureEditor({ seed, picture, onChange }: ProfilePictureEditorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imageInfo, setImageInfo] = useState<ProfileImageInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<ProfilePictureCrop>(CENTER_CROP);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleSelect = async (file: File | undefined) => {
    setError('');
    setStatus('');
    setSelectedFile(null);
    setImageInfo(null);
    setPreviewUrl(null);
    if (!file) return;
    try {
      const info = await validateProfileImageFile(file);
      setSelectedFile(file);
      setImageInfo(info);
      setPreviewUrl(URL.createObjectURL(file));
      setCrop(CENTER_CROP);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applyCrop = async () => {
    if (!selectedFile) return;
    setError('');
    setStatus('');
    try {
      const nextPicture = await prepareProfilePicture(selectedFile, crop);
      onChange(nextPicture);
      setSelectedFile(null);
      setImageInfo(null);
      setPreviewUrl(null);
      setStatus('Picture is ready. Save your profile to publish it.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const removePicture = () => {
    setSelectedFile(null);
    setImageInfo(null);
    setPreviewUrl(null);
    setError('');
    setStatus('Custom picture removed. Save your profile to publish the change.');
    onChange(null);
  };

  const previewStyle = imageInfo
    ? {
        width: `${(imageInfo.width / Math.min(imageInfo.width, imageInfo.height)) * crop.zoom * 100}%`,
        height: `${(imageInfo.height / Math.min(imageInfo.width, imageInfo.height)) * crop.zoom * 100}%`,
        left: `${-((imageInfo.width / Math.min(imageInfo.width, imageInfo.height)) * crop.zoom - 1) * crop.x * 100}%`,
        top: `${-((imageInfo.height / Math.min(imageInfo.width, imageInfo.height)) * crop.zoom - 1) * crop.y * 100}%`
      }
    : undefined;

  return (
    <div className="profile-picture-editor">
      <span className="profile-picture-editor-label">Profile picture</span>
      <div className="profile-picture-editor-preview" aria-label="Profile picture preview">
        {previewUrl && previewStyle ? (
          <img className="profile-picture-crop-image" src={previewUrl} style={previewStyle} alt="Selected image crop preview" />
        ) : (
          <IdentityAvatar seed={seed} size={AVATAR_SIZES.profileEditor} alt="Current profile picture" profilePicture={picture} />
        )}
      </div>
      {selectedFile && imageInfo ? (
        <div className="profile-picture-crop-controls">
          <label>
            Horizontal position
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={crop.x}
              onChange={(event) => setCrop((current) => ({ ...current, x: Number(event.target.value) }))}
            />
          </label>
          <label>
            Vertical position
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={crop.y}
              onChange={(event) => setCrop((current) => ({ ...current, y: Number(event.target.value) }))}
            />
          </label>
          <label>
            Zoom
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={crop.zoom}
              onChange={(event) => setCrop((current) => ({ ...current, zoom: Number(event.target.value) }))}
            />
          </label>
          <p className="note">Select the square crop, then use the picture to update your profile.</p>
          <button className="btn secondary" type="button" onClick={() => void applyCrop()}>
            Use this picture
          </button>
        </div>
      ) : null}
      <label className="profile-picture-file-label">
        {picture ? 'Replace picture' : 'Upload picture'}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => {
            void handleSelect(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
      </label>
      <button
        className="btn secondary"
        type="button"
        disabled={!picture && !selectedFile}
        onClick={removePicture}
      >
        Remove custom picture
      </button>
      {error ? <p className="profile-picture-error" role="alert">{error}</p> : null}
      {status ? <p className="note" role="status">{status}</p> : null}
      <p className="note">Images are cropped and processed in this browser. The saved picture is 256 × 256 pixels and at most 50 KiB.</p>
    </div>
  );
}
