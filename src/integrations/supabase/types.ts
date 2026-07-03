export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      canvasser_stats: {
        Row: {
          contacts_made: number
          created_at: string
          doors_knocked: number
          id: string
          period: string
          period_start: string
          revenue_generated: number
          sales_closed: number
          user_id: string
        }
        Insert: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period: string
          period_start: string
          revenue_generated?: number
          sales_closed?: number
          user_id: string
        }
        Update: {
          contacts_made?: number
          created_at?: string
          doors_knocked?: number
          id?: string
          period?: string
          period_start?: string
          revenue_generated?: number
          sales_closed?: number
          user_id?: string
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          company_name: string
          global_visibility: boolean
          id: boolean
          updated_at: string
        }
        Insert: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          updated_at?: string
        }
        Update: {
          company_name?: string
          global_visibility?: boolean
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      daily_logs: {
        Row: {
          canvasser_id: string
          confirmed_leads: number
          created_at: string
          demos_sits: number
          doors_knocked: number
          future_leads: number
          id: string
          leads_called_in: number
          log_date: string
          next_days: number
          no_demo: number
          no_shows: number
          not_interested: number
          notes: string | null
          one_legs: number
          people_talked_to: number
          renters: number
          sales: number
          team_id: string | null
          unmarked: number
          updated_at: string
        }
        Insert: {
          canvasser_id: string
          confirmed_leads?: number
          created_at?: string
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          not_interested?: number
          notes?: string | null
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          unmarked?: number
          updated_at?: string
        }
        Update: {
          canvasser_id?: string
          confirmed_leads?: number
          created_at?: string
          demos_sits?: number
          doors_knocked?: number
          future_leads?: number
          id?: string
          leads_called_in?: number
          log_date?: string
          next_days?: number
          no_demo?: number
          no_shows?: number
          not_interested?: number
          notes?: string | null
          one_legs?: number
          people_talked_to?: number
          renters?: number
          sales?: number
          team_id?: string | null
          unmarked?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_metrics: {
        Row: {
          blowouts: number
          canvasser_id: string
          created_at: string
          id: string
          killed: number
          leads_called_in: number
          leads_confirmed: number
          leads_submitted: number
          metric_date: string
          no_answers: number
          office_location: string
          outside_leads: number
          pending: number
          pitch_missed: number
          resets: number
          sales: number
          sits_ran_today: number
          updated_at: string
        }
        Insert: {
          blowouts?: number
          canvasser_id: string
          created_at?: string
          id?: string
          killed?: number
          leads_called_in?: number
          leads_confirmed?: number
          leads_submitted?: number
          metric_date?: string
          no_answers?: number
          office_location?: string
          outside_leads?: number
          pending?: number
          pitch_missed?: number
          resets?: number
          sales?: number
          sits_ran_today?: number
          updated_at?: string
        }
        Update: {
          blowouts?: number
          canvasser_id?: string
          created_at?: string
          id?: string
          killed?: number
          leads_called_in?: number
          leads_confirmed?: number
          leads_submitted?: number
          metric_date?: string
          no_answers?: number
          office_location?: string
          outside_leads?: number
          pending?: number
          pitch_missed?: number
          resets?: number
          sales?: number
          sits_ran_today?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      field_pins: {
        Row: {
          canvasser_id: string
          created_at: string
          device_lat: number | null
          device_lng: number | null
          distance_m: number | null
          id: string
          is_remote_drop: boolean
          lat: number
          lng: number
          log_date: string
          note: string | null
          pin_type: Database["public"]["Enums"]["pin_type"]
        }
        Insert: {
          canvasser_id: string
          created_at?: string
          device_lat?: number | null
          device_lng?: number | null
          distance_m?: number | null
          id?: string
          is_remote_drop?: boolean
          lat: number
          lng: number
          log_date?: string
          note?: string | null
          pin_type: Database["public"]["Enums"]["pin_type"]
        }
        Update: {
          canvasser_id?: string
          created_at?: string
          device_lat?: number | null
          device_lng?: number | null
          distance_m?: number | null
          id?: string
          is_remote_drop?: boolean
          lat?: number
          lng?: number
          log_date?: string
          note?: string | null
          pin_type?: Database["public"]["Enums"]["pin_type"]
        }
        Relationships: [
          {
            foreignKeyName: "field_pins_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hype_events: {
        Row: {
          canvasser_id: string | null
          canvasser_name: string | null
          created_at: string
          id: string
          kind: string
          message: string
          payload: Json
        }
        Insert: {
          canvasser_id?: string | null
          canvasser_name?: string | null
          created_at?: string
          id?: string
          kind: string
          message: string
          payload?: Json
        }
        Update: {
          canvasser_id?: string | null
          canvasser_name?: string | null
          created_at?: string
          id?: string
          kind?: string
          message?: string
          payload?: Json
        }
        Relationships: []
      }
      lead_events: {
        Row: {
          canvasser_id: string | null
          count: number
          created_at: string
          id: string
          occurred_at: string
          team_id: string
        }
        Insert: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id: string
        }
        Update: {
          canvasser_id?: string | null
          count?: number
          created_at?: string
          id?: string
          occurred_at?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_events_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          address: string | null
          canvasser_id: string
          created_at: string
          customer_name: string | null
          deny_reason: string | null
          id: string
          is_sale: boolean
          notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sale_amount: number | null
          status: Database["public"]["Enums"]["lead_status"]
          team_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          canvasser_id: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          canvasser_id?: string
          created_at?: string
          customer_name?: string | null
          deny_reason?: string | null
          id?: string
          is_sale?: boolean
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sale_amount?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      offices: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          avg_commission: number
          consecutive_weeks_3_plus_sits: number
          consecutive_weeks_7_plus_sits: number
          created_at: string
          current_rank: string | null
          display_name: string
          id: string
          is_placeholder: boolean
          level: number
          monthly_goal: number
          office_location: string
          recruits_count: number
          rolling_4_week_sit_avg: number
          status: Database["public"]["Enums"]["canvasser_status"]
          team_id: string | null
          updated_at: string
          weekly_income_goal: number
          xp: number
        }
        Insert: {
          avatar_url?: string | null
          avg_commission?: number
          consecutive_weeks_3_plus_sits?: number
          consecutive_weeks_7_plus_sits?: number
          created_at?: string
          current_rank?: string | null
          display_name: string
          id: string
          is_placeholder?: boolean
          level?: number
          monthly_goal?: number
          office_location?: string
          recruits_count?: number
          rolling_4_week_sit_avg?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          weekly_income_goal?: number
          xp?: number
        }
        Update: {
          avatar_url?: string | null
          avg_commission?: number
          consecutive_weeks_3_plus_sits?: number
          consecutive_weeks_7_plus_sits?: number
          created_at?: string
          current_rank?: string | null
          display_name?: string
          id?: string
          is_placeholder?: boolean
          level?: number
          monthly_goal?: number
          office_location?: string
          recruits_count?: number
          rolling_4_week_sit_avg?: number
          status?: Database["public"]["Enums"]["canvasser_status"]
          team_id?: string | null
          updated_at?: string
          weekly_income_goal?: number
          xp?: number
        }
        Relationships: [
          {
            foreignKeyName: "profiles_team_fk"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          active_monday_board_oc: string | null
          active_monday_board_sd: string | null
          created_at: string
          id: boolean
          monday_api_token: string | null
          updated_at: string
        }
        Insert: {
          active_monday_board_oc?: string | null
          active_monday_board_sd?: string | null
          created_at?: string
          id?: boolean
          monday_api_token?: string | null
          updated_at?: string
        }
        Update: {
          active_monday_board_oc?: string | null
          active_monday_board_sd?: string | null
          created_at?: string
          id?: boolean
          monday_api_token?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      teams: {
        Row: {
          captain_id: string | null
          color: string
          created_at: string
          id: string
          name: string
          office_id: string | null
          office_location: string
        }
        Insert: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name: string
          office_id?: string | null
          office_location?: string
        }
        Update: {
          captain_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name?: string
          office_id?: string | null
          office_location?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "offices"
            referencedColumns: ["id"]
          },
        ]
      }
      territories: {
        Row: {
          canvasser_id: string | null
          color: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          polygon: Json
          team_id: string | null
          updated_at: string
        }
        Insert: {
          canvasser_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          polygon: Json
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          canvasser_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          polygon?: Json
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "territories_canvasser_id_fkey"
            columns: ["canvasser_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "territories_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "territories_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          billable_hours: number
          clock_in: string
          clock_out: string | null
          created_at: string
          id: string
          log_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          billable_hours?: number
          clock_in?: string
          clock_out?: string | null
          created_at?: string
          id?: string
          log_date?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          billable_hours?: number
          clock_in?: string
          clock_out?: string | null
          created_at?: string
          id?: string
          log_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      turfs: {
        Row: {
          assigned_user_id: string | null
          color: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          notes: string | null
          polygon_coordinates: Json
          updated_at: string
        }
        Insert: {
          assigned_user_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          notes?: string | null
          polygon_coordinates: Json
          updated_at?: string
        }
        Update: {
          assigned_user_id?: string | null
          color?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          notes?: string | null
          polygon_coordinates?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "turfs_assigned_user_id_fkey"
            columns: ["assigned_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turfs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_logs: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          raw_payload: Json | null
          source: string | null
          step: string | null
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          raw_payload?: Json | null
          source?: string | null
          step?: string | null
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          raw_payload?: Json | null
          source?: string | null
          step?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auto_clock_out_expired: { Args: never; Returns: number }
      calc_monthly_paycheck: {
        Args: { _canvasser_id: string; _month_start: string }
        Returns: {
          month_end: string
          month_start: string
          sale_price_total: number
          total_pay: number
          total_points: number
          total_sales: number
          total_sits: number
          volume_bonus: number
          weekly_pay_total: number
        }[]
      }
      calc_weekly_paycheck: {
        Args: { _canvasser_id: string; _week_start: string }
        Returns: {
          base_pay: number
          commission: number
          commission_rate: number
          hourly_rate: number
          hours: number
          monster_bonus: number
          points: number
          rank: string
          sale_price_total: number
          sales: number
          sit_bonus: number
          sits: number
          total_pay: number
          week_end: string
          week_start: string
        }[]
      }
      evaluate_canvasser_suspension: {
        Args: { _canvasser_id: string }
        Returns: undefined
      }
      global_visibility_on: { Args: never; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      my_team_id: { Args: { _user_id: string }; Returns: string }
      refresh_canvasser_rank: {
        Args: { _canvasser_id: string }
        Returns: string
      }
    }
    Enums: {
      app_role: "owner" | "captain" | "canvasser" | "office_staff"
      canvasser_status:
        | "active"
        | "suspended"
        | "inactive"
        | "suspension_review"
      lead_status: "pending" | "confirmed" | "denied"
      pin_type: "not_home" | "talked_to" | "lead"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "captain", "canvasser", "office_staff"],
      canvasser_status: [
        "active",
        "suspended",
        "inactive",
        "suspension_review",
      ],
      lead_status: ["pending", "confirmed", "denied"],
      pin_type: ["not_home", "talked_to", "lead"],
    },
  },
} as const
