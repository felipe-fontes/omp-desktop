//! Startup cancellation is independent of the slow workspace lifecycle guard.
use super::Registry;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};

pub struct Admission {
    generation: u64,
    cancelled: Arc<AtomicBool>,
    first_cancelled: Option<Arc<AtomicBool>>,
}

/// One admitted naming worker. Drop only after its subprocess has been reaped.
pub struct NamingAdmission<'a> {
    manager: &'a WorkspaceManager,
}

impl Drop for NamingAdmission<'_> {
    fn drop(&mut self) {
        let mut active = self
            .manager
            .naming
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *active -= 1;
        if *active == 0 {
            self.manager.naming_drained.notify_all();
        }
    }
}

#[derive(Default)]
struct FirstAttempts {
    last_started: u32,
    committed: u32,
    cancelled_through: u32,
    active: Option<(u32, Weak<AtomicBool>)>,
}

/// This gate is independent of the slow checkout/lifecycle mutex.
#[derive(Clone, Copy)]
pub enum TaskAdmission {
    Pending,
    Changing,
    Ready,
    Used,
}

#[derive(Default)]
pub struct WorkspaceManager {
    pub(super) registry: Mutex<Registry>,
    pending: Mutex<HashMap<String, Weak<AtomicBool>>>,
    tasks: Mutex<HashMap<String, TaskAdmission>>,
    attempts: Mutex<HashMap<String, FirstAttempts>>,
    naming: Mutex<usize>,
    naming_drained: Condvar,
    generation: AtomicU64,
    closed: AtomicBool,
}

impl WorkspaceManager {
    /// A single guard covers ref checks, any checkout, tab registration and
    /// agent spawn. Close uses the same guard until all children have stopped.
    pub fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Admit before dropping the lifecycle lock. Shutdown closes admission
    /// under this same mutex, then waits without holding the lifecycle lock.
    pub(crate) fn begin_naming(&self, ticket: &Admission) -> Result<NamingAdmission<'_>, String> {
        let mut active = self.naming.lock().unwrap_or_else(PoisonError::into_inner);
        self.check_ticket(ticket)?;
        *active += 1;
        drop(active);
        Ok(NamingAdmission { manager: self })
    }

    pub(super) fn register_pending(&self, id: &str) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), TaskAdmission::Pending);
        self.attempts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.to_owned())
            .or_default();
    }

    /// Reserve a choice before any slow validation. Concurrent task sends
    /// fail closed until the lifecycle operation commits or rolls back.
    pub(super) fn begin_choice(&self, id: &str) -> Result<TaskAdmission, String> {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        let mode = tasks
            .get_mut(id)
            .ok_or_else(|| "conversation cannot change its workspace".to_string())?;
        let result = match *mode {
            TaskAdmission::Pending | TaskAdmission::Ready => {
                let previous = *mode;
                *mode = TaskAdmission::Changing;
                Ok(previous)
            }
            TaskAdmission::Changing | TaskAdmission::Used => {
                Err("workspace cannot change after a task has started".into())
            }
        };
        drop(tasks);
        result
    }

    pub(super) fn finish_choice(&self, id: &str, previous: TaskAdmission, pending: Option<bool>) {
        if let Some(mode) = self
            .tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(id)
        {
            *mode = match pending {
                Some(true) => TaskAdmission::Pending,
                Some(false) => TaskAdmission::Ready,
                None => previous,
            };
        }
    }

    pub(super) fn first_spawned(&self, id: &str) {
        if let Some(mode) = self
            .tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(id)
        {
            *mode = TaskAdmission::Used;
        }
    }

    pub fn admit_command(&self, id: &str, task: bool) -> Result<(), String> {
        if !task {
            return Ok(());
        }
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mode) = tasks.get_mut(id) {
            match mode {
                TaskAdmission::Pending | TaskAdmission::Changing => {
                    return Err(
                        "choose or prepare the conversation workspace before starting a task"
                            .into(),
                    );
                }
                TaskAdmission::Ready => *mode = TaskAdmission::Used,
                TaskAdmission::Used => {}
            }
        }
        drop(tasks);
        Ok(())
    }

    /// Correlated login inputs from an ambient-enabled Local process cannot
    /// carry over to a newly pending Worktree choice during its respawn.
    pub(crate) fn admit_metadata_login(&self, id: &str, metadata_only: bool) -> Result<(), String> {
        let tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        match tasks.get(id) {
            Some(TaskAdmission::Changing | TaskAdmission::Pending) if !metadata_only => {
                Err("wait for the metadata-only process before logging in".into())
            }
            Some(TaskAdmission::Changing) => Err("workspace choice is changing".into()),
            _ => Ok(()),
        }
    }

    pub fn has_unstarted_choice(&self, id: &str) -> bool {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .is_some_and(|mode| !matches!(mode, TaskAdmission::Used))
    }

    pub(crate) fn suspend_task_admission(&self, id: &str) -> Option<TaskAdmission> {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        tasks.get_mut(id).map(|mode| {
            let previous = *mode;
            *mode = TaskAdmission::Changing;
            previous
        })
    }

    pub(crate) fn restore_task_admission(&self, id: &str, admission: Option<TaskAdmission>) {
        if let Some(admission) = admission {
            self.tasks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id.to_owned(), admission);
        }
    }

    pub(crate) fn release_task_admission<S: AsRef<str>>(&self, ids: &[S]) {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        for id in ids {
            tasks.remove(id.as_ref());
        }
        drop(tasks);
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        for id in ids {
            attempts.remove(id.as_ref());
        }
    }

    /// Capture admission without waiting for filesystem or lifecycle work.
    /// Starts and shell opens for the same tab share its cancellation flag.
    pub fn ticket(&self, id: &str) -> Result<Admission, String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if self.closed.load(Ordering::SeqCst) {
            return Err("application is shutting down".to_string());
        }
        // The flag and reload generation must be captured under the same lock.
        let generation = self.generation.load(Ordering::SeqCst);
        pending.retain(|_, flag| flag.strong_count() > 0);
        let cancelled = pending.get(id).and_then(Weak::upgrade).unwrap_or_else(|| {
            let flag = Arc::new(AtomicBool::new(false));
            // Weak entries track queued work without retaining completed tab ids.
            pending.insert(id.to_string(), Arc::downgrade(&flag));
            flag
        });
        drop(pending);
        Ok(Admission {
            generation,
            cancelled,
            first_cancelled: None,
        })
    }

    /// Admit one monotonically numbered first-prompt operation. The separate
    /// cancellation flag never cancels a tab's shell or ordinary respawn.
    pub(crate) fn first_ticket(&self, id: &str, attempt: u32) -> Result<Admission, String> {
        if attempt == 0 {
            return Err("first-prompt attempt must be positive".into());
        }
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        let state = attempts
            .get_mut(id)
            .ok_or_else(|| "conversation has no pending first prompt".to_string())?;
        if attempt <= state.cancelled_through {
            return Err("first-prompt attempt was cancelled".into());
        }
        if attempt <= state.last_started {
            return Err("first-prompt attempt was already started".into());
        }
        if state
            .active
            .as_ref()
            .is_some_and(|(_, flag)| flag.strong_count() > 0)
        {
            return Err("first-prompt preparation is already in progress".into());
        }
        let mut ticket = self.ticket(id)?;
        let flag = Arc::new(AtomicBool::new(false));
        state.last_started = attempt;
        state.active = Some((attempt, Arc::downgrade(&flag)));
        ticket.first_cancelled = Some(flag);
        drop(attempts);
        Ok(ticket)
    }

    /// Record cancellation even when it arrives before the corresponding
    /// start IPC. An older cancellation never touches a newer active attempt.
    pub(crate) fn cancel_first(&self, id: &str, attempt: u32) -> Result<bool, String> {
        if attempt == 0 {
            return Err("first-prompt attempt must be positive".into());
        }
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        let state = attempts
            .get_mut(id)
            .ok_or_else(|| "conversation has no pending first prompt".to_string())?;
        if attempt <= state.last_started {
            if state.committed == attempt {
                return Ok(false);
            }
            let Some(flag) = state
                .active
                .as_ref()
                .filter(|(active, _)| *active == attempt)
                .and_then(|(_, flag)| flag.upgrade())
            else {
                return Ok(false);
            };
            state.cancelled_through = state.cancelled_through.max(attempt);
            flag.store(true, Ordering::SeqCst);
            drop(attempts);
            return Ok(true);
        }
        state.cancelled_through = state.cancelled_through.max(attempt);
        drop(attempts);
        Ok(true)
    }

    /// Atomically commit the native workspace transition against cancellation.
    pub(crate) fn commit_first(
        &self,
        id: &str,
        attempt: u32,
        ticket: &Admission,
        commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        let state = attempts
            .get_mut(id)
            .ok_or_else(|| "conversation has no pending first prompt".to_string())?;
        self.check_ticket(ticket)?;
        let active = state
            .active
            .as_ref()
            .filter(|(number, _)| *number == attempt)
            .and_then(|(_, flag)| flag.upgrade());
        if !active
            .as_ref()
            .zip(ticket.first_cancelled.as_ref())
            .is_some_and(|(active, expected)| Arc::ptr_eq(active, expected))
        {
            return Err("first-prompt attempt is no longer active".into());
        }
        commit()?;
        state.committed = attempt;
        drop(attempts);
        Ok(())
    }

    pub fn check_ticket(&self, ticket: &Admission) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != ticket.generation
            || ticket.cancelled.load(Ordering::SeqCst)
            || ticket
                .first_cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Err("session start was cancelled".to_string());
        }
        Ok(())
    }

    pub fn cancel_pending<S: AsRef<str>>(&self, ids: &[S]) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        for id in ids {
            if let Some(flag) = pending.remove(id.as_ref()).and_then(|flag| flag.upgrade()) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn invalidate_pending(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        self.generation.fetch_add(1, Ordering::SeqCst);
        pending.clear();
    }

    pub fn shutdown(&self) {
        let mut active = self.naming.lock().unwrap_or_else(PoisonError::into_inner);
        self.closed.store(true, Ordering::SeqCst);
        self.invalidate_pending();
        while *active != 0 {
            active = self
                .naming_drained
                .wait(active)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(active);
    }
}
