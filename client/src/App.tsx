import { useEffect } from 'react';
import { ParticleCanvas } from './components/ParticleCanvas';
import { CursorRing } from './components/CursorRing';
import { DuplicatePhotoDialog } from './components/DuplicatePhotoDialog';
import { GraphOverlay } from './components/GraphOverlay';
import { PeopleOverlay } from './components/PeopleOverlay';
import { PhotoDissolve } from './components/PhotoDissolve';
import { ProfileOverlay } from './components/ProfileOverlay';
import { ReviewOverlay } from './components/ReviewOverlay';
import { SessionView } from './components/SessionView';
import { TimelinePage } from './components/TimelinePage';
import { Toast } from './components/Toast';
import { UserPickerOverlay } from './components/UserPickerOverlay';
import { useAppStore } from './store/useAppStore';
import { useUserStore } from './store/useUserStore';

export default function App() {
  const view = useAppStore((s) => s.view);
  useEffect(() => {
    // Auth + migration happen inside useUserStore.load → onAuthed (covers login/bootstrap too).
    void useUserStore.getState().load();
  }, []);
  return (
    <>
      {/* root-level so the particle canvas (z 1) can splash sand over the photo (z 0) */}
      <PhotoDissolve />
      <ParticleCanvas />
      {view === 'timeline' ? <TimelinePage /> : <SessionView />}
      <ReviewOverlay />
      <PeopleOverlay />
      <GraphOverlay />
      <ProfileOverlay />
      <UserPickerOverlay />
      <DuplicatePhotoDialog />
      <Toast />
      <CursorRing />
    </>
  );
}
