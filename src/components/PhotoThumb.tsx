import { useEffect, useState } from 'react';
import { db } from '../db';

export default function PhotoThumb({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    db.photos.get(id).then((p) => {
      if (p) {
        u = URL.createObjectURL(p.blob);
        setUrl(u);
      }
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [id]);
  return (
    <div className="thumb">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="점검 사진" />
        </a>
      ) : (
        <div className="ph" />
      )}
      {onRemove && (
        <button className="x" aria-label="사진 삭제" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
