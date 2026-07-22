package com.nianxiang.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.core.view.WindowCompat
import com.nianxiang.app.ui.AppRoot
import com.nianxiang.app.ui.AppViewModel
import com.nianxiang.app.ui.NianxiangTheme
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    private val viewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        setContent {
            NianxiangTheme {
                val state by viewModel.state.collectAsStateWithLifecycle()
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppRoot(state, viewModel)
                    state.toast?.let { message ->
                        // Key on toastSeq, not the text, so a repeated identical message
                        // still restarts the 3.2s dismiss timer.
                        LaunchedEffect(state.toastSeq) {
                            delay(3200)
                            viewModel.clearToast()
                        }
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                            Text(
                                message,
                                modifier = Modifier
                                    .padding(24.dp)
                                    .background(Color(0xE61E1E23), RoundedCornerShape(50))
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                                color = Color.White,
                            )
                        }
                    }
                }
            }
        }
    }
}
