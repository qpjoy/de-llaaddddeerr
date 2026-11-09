from __future__ import annotations

import sys
import time
from typing import Any, Dict


def simple_progress_callback(completed: int, total: int, percentage: float, stats: Dict[str, Any]) -> None:
    """Simple progress callback that prints completion percentage."""
    print(f"\rProgress: {completed}/{total} ({percentage:.1f}%) - Success: {stats.get('success', 0)}, Failed: {stats.get('failed', 0)}", end="", flush=True)
    if completed == total:
        print()


def detailed_progress_callback(completed: int, total: int, percentage: float, stats: Dict[str, Any]) -> None:
    """Detailed progress callback with current URL and statistics."""
    current_url = stats.get('current_url', '')
    success = stats.get('success', 0)
    failed = stats.get('failed', 0)
    parse_failed = stats.get('parse_failed', 0)
    
    status_line = f"Progress: {completed}/{total} ({percentage:.1f}%)"
    stats_line = f"✓ {success} ✗ {failed}"
    if parse_failed > 0:
        stats_line += f" ⚠ {parse_failed}"
    
    if current_url:
        url_display = current_url if len(current_url) <= 50 else current_url[:47] + "..."
        print(f"\r{status_line} | {stats_line} | {url_display}", end="", flush=True)
    else:
        print(f"\r{status_line} | {stats_line}", end="", flush=True)
    
    if completed == total:
        print()


class ProgressBar:
    """A customizable progress bar for tracking scraping progress."""
    
    def __init__(self, width: int = 50, show_stats: bool = True, show_url: bool = False):
        self.width = width
        self.show_stats = show_stats
        self.show_url = show_url
        self.start_time = time.time()
    
    def __call__(self, completed: int, total: int, percentage: float, stats: Dict[str, Any]) -> None:
        """Progress callback that displays a visual progress bar."""
        if completed == 0:
            self.start_time = time.time()
        
        filled = int(self.width * percentage / 100)
        bar = "█" * filled + "░" * (self.width - filled)
        
        elapsed = time.time() - self.start_time
        if completed > 0:
            eta = (elapsed / completed) * (total - completed)
            eta_str = f" ETA: {eta:.0f}s" if eta > 1 else " ETA: <1s"
        else:
            eta_str = ""
        
        progress_line = f"\r[{bar}] {percentage:.1f}%{eta_str}"
        
        if self.show_stats:
            success = stats.get('success', 0)
            failed = stats.get('failed', 0)
            parse_failed = stats.get('parse_failed', 0)
            stats_str = f" | ✓{success} ✗{failed}"
            if parse_failed > 0:
                stats_str += f" ⚠{parse_failed}"
            progress_line += stats_str
        
        if self.show_url:
            current_url = stats.get('current_url', '')
            if current_url:
                url_display = current_url if len(current_url) <= 30 else current_url[:27] + "..."
                progress_line += f" | {url_display}"
        
        print(progress_line, end="", flush=True)
        
        if completed == total:
            print(f"\nCompleted in {elapsed:.1f}s")


class StatTracker:
    """Advanced progress tracker that collects detailed statistics."""
    
    def __init__(self):
        self.start_time = None
        self.stats_history = []
        self.errors = []
    
    def __call__(self, completed: int, total: int, percentage: float, stats: Dict[str, Any]) -> None:
        if self.start_time is None:
            self.start_time = time.time()
        
        current_time = time.time()
        elapsed = current_time - self.start_time
        
        self.stats_history.append({
            'timestamp': current_time,
            'completed': completed,
            'percentage': percentage,
            'elapsed': elapsed,
            'stats': stats.copy()
        })
        
        if stats.get('failed', 0) > len(self.errors):
            self.errors.append({
                'url': stats.get('current_url', ''),
                'timestamp': current_time
            })
        
        rate = completed / elapsed if elapsed > 0 else 0
        eta = (total - completed) / rate if rate > 0 else 0
        
        print(f"\rProgress: {completed}/{total} ({percentage:.1f}%) | Rate: {rate:.1f}/s | ETA: {eta:.0f}s", end="", flush=True)
        
        if completed == total:
            print(f"\nFinal stats: {stats}")
            print(f"Total time: {elapsed:.1f}s")
            print(f"Average rate: {total/elapsed:.1f} items/s")
    
    def get_summary(self) -> Dict[str, Any]:
        """Get a summary of the scraping session."""
        if not self.stats_history:
            return {}
        
        final_stats = self.stats_history[-1]
        return {
            'total_time': final_stats['elapsed'],
            'total_completed': final_stats['completed'],
            'average_rate': final_stats['completed'] / final_stats['elapsed'],
            'final_stats': final_stats['stats'],
            'error_count': len(self.errors),
            'errors': self.errors
        } 