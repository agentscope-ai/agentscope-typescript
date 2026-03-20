import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useEffect, useState } from 'react';
import Joyride from 'react-joyride';
import {
    createHashRouter,
    RouterProvider,
    Outlet,
    Route,
    createRoutesFromElements,
} from 'react-router-dom';

import { AppLayout } from '@/components/layout/AppLayout';
import { OllamaDetection } from '@/components/onboarding/OllamaDetection';
import { OllamaSetup } from '@/components/onboarding/OllamaSetup';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { TourTooltip } from '@/components/tour/TourTooltip';
import { Toaster } from '@/components/ui/sonner';
import { LayoutProvider } from '@/contexts/LayoutContext';
import { ScheduleProvider } from '@/contexts/ScheduleContext';
import { useConfig } from '@/hooks/use-config';
import { useTour } from '@/hooks/use-tour';
import { AgentPage } from '@/pages/agent';
import { ChatPage } from '@/pages/chat';
import { EditorPage } from '@/pages/editor';
import { MCPPage } from '@/pages/mcp';
import { NewsPage } from '@/pages/news';
import { SchedulePage } from '@/pages/schedule';
import { SettingPage } from '@/pages/setting';
import { SkillPage } from '@/pages/skill';

/**
 * Main application routes component that handles routing and tour functionality.
 *
 * @returns The application routes with tour overlay.
 */
function AppRoutes() {
    const { config } = useConfig();
    const { run, steps, stepIndex, startTour, handleJoyrideCallback } = useTour();

    useEffect(() => {
        if (config?.onboardingCompleted && !config?.tourCompleted) {
            setTimeout(() => startTour(), 500);
        }
    }, [config?.onboardingCompleted, config?.tourCompleted, startTour]);

    return (
        <>
            <Outlet />
            {/*The tour component that guides users through the main features of the application.*/}
            <Joyride
                steps={steps}
                run={run}
                stepIndex={stepIndex}
                callback={handleJoyrideCallback}
                continuous
                showProgress={false}
                showSkipButton={false}
                disableOverlayClose
                spotlightClicks
                tooltipComponent={TourTooltip}
                styles={{
                    options: {
                        overlayColor: 'rgba(0, 0, 0, 0.5)',
                        zIndex: 10000,
                    },
                    spotlight: {
                        borderRadius: 4,
                    },
                }}
                locale={{
                    back: 'Back',
                    close: 'Close',
                    last: 'Finish',
                    next: 'Next',
                    skip: 'Skip',
                }}
            />
        </>
    );
}

const router = createHashRouter(
    createRoutesFromElements(
        <Route element={<AppRoutes />}>
            <Route element={<AppLayout />}>
                <Route path="/" element={<ChatPage />} />
                <Route path="/news" element={<NewsPage />} />
                <Route path="/setting" element={<SettingPage />} />
                <Route path="/schedule" element={<SchedulePage />} />
                <Route path="/skill" element={<SkillPage />} />
                <Route path="/mcp" element={<MCPPage />} />
                <Route path="/editor" element={<EditorPage />} />
                <Route path="/agents" element={<AgentPage />} />
            </Route>
        </Route>
    )
);

/**
 * Root application component that handles onboarding flow and main app rendering.
 *
 * @returns The root application component.
 */
function App(): React.JSX.Element {
    const { config, loading, updateConfig } = useConfig();
    const [onboardingStep, setOnboardingStep] = useState<
        'wizard' | 'detection' | 'ollama' | 'complete'
    >('wizard');

    // Show loading state while config is being fetched
    if (loading) {
        return (
            <div className="h-screen flex items-center justify-center bg-background">
                <div className="text-muted-foreground"></div>
            </div>
        );
    }

    // Show onboarding flow for first-time users
    if (!config?.onboardingCompleted) {
        if (onboardingStep === 'wizard') {
            return <OnboardingWizard onComplete={() => setOnboardingStep('detection')} />;
        }

        if (onboardingStep === 'detection') {
            return (
                <OllamaDetection
                    onDetected={() => setOnboardingStep('ollama')}
                    onNotAvailable={async () => {
                        await updateConfig({ onboardingCompleted: true });
                        setOnboardingStep('complete');
                    }}
                />
            );
        }

        if (onboardingStep === 'ollama') {
            return (
                <OllamaSetup
                    onSkip={async () => {
                        await updateConfig({ onboardingCompleted: true });
                        setOnboardingStep('complete');
                    }}
                    onComplete={async () => {
                        await updateConfig({ onboardingCompleted: true });
                        setOnboardingStep('complete');
                    }}
                />
            );
        }
    }

    // Show normal application
    return (
        <TooltipProvider>
            <LayoutProvider>
                <ScheduleProvider>
                    <RouterProvider router={router} />
                    <Toaster />
                </ScheduleProvider>
            </LayoutProvider>
        </TooltipProvider>
    );
}

export default App;
